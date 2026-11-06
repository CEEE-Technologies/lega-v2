import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ClsService } from 'nestjs-cls';
import { JWT_AUDIENCE, JWT_ISSUER } from '../Auth/Auth.constants';
import { JwtPayload } from '../Auth/Auth.interfaces';
import { SystemUser } from '../System/models/SystemUser';
import { TenantModel } from '../System/models/TenantModel';
import { UserTenant } from '../System/models/UserTenant.model';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { TenantUser } from '../Tenancy/TenancyModels/models/TenantUser.model';

/** Rooms: one per organization and one per login. */
export const organizationRoom = (organizationId: string) =>
  `org:${organizationId}`;
export const userRoom = (userId: number) => `user:${userId}`;

interface SocketSession {
  userId: number;
  organizationId?: string;
}

@WebSocketGateway({
  namespace: '/',
  path: '/socket',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
export class SocketGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private logger: Logger = new Logger('SocketGateway');
  private readonly jwtService = new JwtService({});

  constructor(
    private readonly configService: ConfigService,
    private readonly cls: ClsService,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    @Inject(TenantModel.name)
    private readonly tenantModel: typeof TenantModel,

    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,
  ) {}

  /**
   * Every connection needs a valid sign-in token. A connection for an
   * organization also needs the user to be an active member of it.
   */
  afterInit(server: Server) {
    server.use((socket, next) => {
      this.authenticate(socket)
        .then((session) => {
          socket.data.session = session;
          next();
        })
        .catch((error) => {
          next(new Error(error?.message || 'Unauthorized'));
        });
    });
    this.logger.log('Socket.IO Gateway initialized');
  }

  handleConnection(client: Socket, ..._args: any[]) {
    const session: SocketSession | undefined = client.data?.session;

    // The middleware above refuses connections without a session.
    if (!session) {
      client.disconnect(true);
      return;
    }
    client.join(userRoom(session.userId));

    if (session.organizationId) {
      client.join(organizationRoom(session.organizationId));
    }
  }

  handleDisconnect(_client: Socket) {}

  /**
   * Checks the token and the organization given when connecting.
   * @param {Socket} socket
   * @returns {Promise<SocketSession>}
   */
  private async authenticate(socket: Socket): Promise<SocketSession> {
    const auth = socket.handshake.auth || {};
    const header = socket.handshake.headers?.authorization || '';
    const token =
      auth.token ||
      (header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');

    if (!token) {
      throw new Error('Sign in to receive live updates.');
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: this.configService.get<string>('jwt.secret'),
        algorithms: ['HS384'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    } catch {
      throw new Error('Unauthorized');
    }
    const user = await this.systemUserModel
      .query()
      .findById(Number(payload.sub));

    // The session ends when the login is gone or its password was reset.
    if (!user || (payload.sv ?? 0) !== (user.sessionVersion ?? 0)) {
      throw new Error('Unauthorized');
    }
    const organizationId =
      auth.organizationId || socket.handshake.headers?.['organization-id'];

    if (!organizationId) {
      return { userId: user.id };
    }
    if (!(await this.isActiveMember(user.id, String(organizationId)))) {
      throw new Error('You do not have access to this organization.');
    }
    return { userId: user.id, organizationId: String(organizationId) };
  }

  /**
   * Whether the login is an active member of the organization.
   * @param {number} userId
   * @param {string} organizationId
   * @returns {Promise<boolean>}
   */
  private async isActiveMember(
    userId: number,
    organizationId: string,
  ): Promise<boolean> {
    const tenant = await this.tenantModel.query().findOne({ organizationId });
    if (!tenant) return false;

    const membership = await this.userTenantModel
      .query()
      .findOne({ userId, tenantId: tenant.id });
    if (!membership) return false;
    if (!tenant.initializedAt) return true;

    return this.cls.run(async () => {
      this.cls.set('organizationId', organizationId);
      // The organization's database resolves from the context.
      await this.cls.resolveProxyProviders();
      const tenantUser = await this.tenantUserModel()
        .query()
        .findOne({ systemUserId: userId });

      return !(tenantUser && tenantUser.active != null && !tenantUser.active);
    });
  }

  /**
   * The value from the current request or job context, if there is one.
   */
  private fromContext<T>(key: string): T | undefined {
    try {
      return this.cls.isActive() ? (this.cls.get(key) as T) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Sends the event to the members of the organization. Without one, it is
   * not sent, rather than sent to everyone.
   */
  private emitToOrganization(event: string, organizationId?: string) {
    const target = organizationId || this.fromContext<string>('organizationId');

    if (!target) {
      this.logger.warn(`Not sent ${event}: no organization.`);
      return;
    }
    this.server.to(organizationRoom(target)).emit(event);
  }

  /**
   * Emits NEW_TRANSACTIONS_DATA to the organization of the current job,
   * or the given one.
   * @param {string} organizationId
   */
  emitNewTransactionsData(organizationId?: string) {
    this.emitToOrganization('NEW_TRANSACTIONS_DATA', organizationId);
  }

  /**
   * Emits SUBSCRIPTION_CHANGED to the organization of the current request,
   * or the given one.
   * @param {string} organizationId
   */
  emitSubscriptionChanged(organizationId?: string) {
    this.emitToOrganization('SUBSCRIPTION_CHANGED', organizationId);
  }

  /**
   * Emits WORKSPACES_CHANGED to the login of the current request or job
   * (who created or deleted the workspace), or the given one.
   * @param {number} userId
   */
  emitWorkspacesChanged(userId?: number) {
    const target = userId || this.fromContext<number>('userId');

    if (!target) {
      this.logger.warn('Not sent WORKSPACES_CHANGED: no user.');
      return;
    }
    this.server.to(userRoom(target)).emit('WORKSPACES_CHANGED');
  }
}
