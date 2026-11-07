import { Inject, Injectable } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConfigService } from '@nestjs/config';
import { UserTenant } from '@/modules/System/models/UserTenant.model';
import { SystemUser } from '@/modules/System/models/SystemUser';
import { WorkspaceDto } from '../dtos/WorkspaceResponse.dto';
import { WorkspaceTransformer } from '../transformers/WorkspaceTransformer';
import { TransformerInjectable } from '@/modules/Transformer/TransformerInjectable.service';
import { S3_CLIENT } from '@/modules/S3/S3.module';
import { WorkspacesFinancialsService } from './WorkspacesFinancials.service';
import { OrgFinancialTotalsMap } from '@/modules/Analytics/Analytics.constants';
import { ClsService } from 'nestjs-cls';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenantUser } from '@/modules/Tenancy/TenancyModels/models/TenantUser.model';
import { TenantModel } from '@/modules/System/models/TenantModel';
import { getAbilityForRole } from '@/modules/Roles/TenantAbilities';
import { ReportsAction } from '@/modules/FinancialStatements/types/Report.types';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { WorkspaceUserStatusService } from './WorkspaceUserStatus.service';

@Injectable()
export class GetWorkspacesService {
  constructor(
    @Inject(UserTenant.name)
    private readonly userTenantModel: typeof UserTenant,

    @Inject(SystemUser.name)
    private readonly systemUserModel: typeof SystemUser,

    private readonly transformer: TransformerInjectable,

    @Inject(S3_CLIENT)
    private readonly s3Client: S3Client,

    private readonly configService: ConfigService,

    private readonly workspacesFinancials: WorkspacesFinancialsService,

    @Inject(TenantUser.name)
    private readonly tenantUserModel: TenantModelProxy<typeof TenantUser>,

    private readonly cls: ClsService,
    private readonly workspaceUserStatus: WorkspaceUserStatusService,
  ) {}

  /**
   * Generates a presigned URL for the given S3 key.
   */
  private async getPresignedUrl(key: string): Promise<string> {
    const config = this.configService.get('s3');
    const command = new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    });
    return getSignedUrl(this.s3Client, command, { expiresIn: 300 });
  }

  /**
   * Returns all workspaces (organizations) the given user belongs to,
   * including their metadata, build status, and financial data.
   * @param includeInactive - Whether to include inactive workspaces (default: false)
   * @param currentOrganizationId - Current org ID to sort first (only when includeInactive is false)
   */
  async getWorkspaces(
    userId: number,
    includeInactive: boolean = false,
    currentOrganizationId?: string,
  ): Promise<WorkspaceDto[]> {
    const memberships = await this.userTenantModel
      .query()
      .where('userId', userId)
      .withGraphFetched('tenant.metadata');

    // Get user's default tenant ID
    const user = await this.systemUserModel
      .query()
      .select('defaultTenantId')
      .where('id', userId)
      .first();

    const defaultTenantId = user?.defaultTenantId;

    // Generate presigned URLs for workspace logos
    const logoUris: Record<string, string> = {};
    const logoPromises = memberships
      .filter((m) => m.tenant?.metadata?.logoKey)
      .map(async (membership) => {
        const logoKey = membership.tenant.metadata.logoKey;
        const orgId = membership.tenant.organizationId;
        try {
          const logoUri = await this.getPresignedUrl(logoKey);
          logoUris[orgId] = logoUri;
        } catch {
          // If presigned URL generation fails, skip this logo
        }
      });

    await Promise.all(logoPromises);

    // Compute the financial totals (assets/liabilities) of the ready
    // organizations where the user may see them.
    const financialTotals = await this.getFinancialTotals(userId, memberships);

    // The organizations where the user is deactivated (shown greyed out).
    const inactiveOrganizationIds =
      await this.workspaceUserStatus.getInactiveOrganizationIds(
        userId,
        memberships,
      );

    return this.transformer.transform(memberships, new WorkspaceTransformer(), {
      inactiveOrganizationIds,
      defaultTenantId,
      includeInactive,
      currentOrganizationId,
      logoUris,
      financialTotals,
    });
  }

  /**
   * Computes the financial totals of the ready organizations.
   * @param {UserTenant[]} memberships
   * @returns {Promise<OrgFinancialTotalsMap>}
   */
  private async getFinancialTotals(
    userId: number,
    memberships: UserTenant[],
  ): Promise<OrgFinancialTotalsMap> {
    const organizationIds: string[] = [];

    for (const membership of memberships) {
      const tenant = membership.tenant;
      const isReady =
        tenant &&
        tenant.isReady &&
        !tenant.isBuildRunning &&
        !tenant.isDeleting &&
        tenant.isActive;

      if (isReady && (await this.canSeeTotals(userId, membership))) {
        organizationIds.push(tenant.organizationId);
      }
    }

    if (organizationIds.length === 0) {
      return new Map();
    }
    return this.workspacesFinancials.getTotals(organizationIds);
  }

  /**
   * Whether the user may see the organization's totals: the owner, or a user
   * who is active there and may read the balance sheet. The totals are the
   * balance sheet's, so nobody else sees them.
   * @param {number} userId - System user id.
   * @param {UserTenant} membership
   * @returns {Promise<boolean>}
   */
  private async canSeeTotals(
    userId: number,
    membership: UserTenant,
  ): Promise<boolean> {
    if (membership.role === 'owner') return true;

    const tenant = membership.tenant as TenantModel;
    const previousOrganizationId = this.cls.get('organizationId');
    this.cls.set('organizationId', tenant.organizationId);
    try {
      const tenantUser = await this.tenantUserModel()
        .query()
        .findOne({ systemUserId: userId })
        .withGraphFetched('role.permissions');

      if (!tenantUser?.role) return false;
      if (tenantUser.active != null && !tenantUser.active) return false;

      return getAbilityForRole(tenantUser.role).can(
        ReportsAction.READ_BALANCE_SHEET,
        AbilitySubject.Report,
      );
    } catch {
      return false;
    } finally {
      // The rest of the request reads the current organization from here.
      this.cls.set('organizationId', previousOrganizationId);
    }
  }
}
