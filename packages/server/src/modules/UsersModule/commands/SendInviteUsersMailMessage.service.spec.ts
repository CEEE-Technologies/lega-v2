import { SendInviteUsersMailMessage } from './SendInviteUsersMailMessage.service';
import { SendInviteUserMailProcessor } from '../processors/SendInviteUserMail.processor';

describe('Invite mail when the mail server is down', () => {
  const smtpDown = new Error('connect ECONNREFUSED 127.0.0.1:587');
  const service = () =>
    new SendInviteUsersMailMessage(
      { send: jest.fn().mockRejectedValue(smtpDown) } as any,
      {
        getTenant: jest
          .fn()
          .mockResolvedValue({ metadata: { name: 'Acme Ltd' } }),
      } as any,
      { get: () => 'http://localhost' } as any,
    );
  const fromUser = { firstName: 'Priya', lastName: 'Owner', email: 'p@x.io' };
  const invite = { email: 'new@x.io', token: 'tok' };

  beforeAll(() => {
    global.__images_dirname = global.__images_dirname || '/tmp';
  });

  it('the send failure is returned to the caller, not left floating', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      await expect(
        service().sendInviteMail(fromUser as any, invite as any),
      ).rejects.toBe(smtpDown);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('the queue job fails (so BullMQ retries and logs it)', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    const processor = new SendInviteUserMailProcessor(
      service(),
      { set: jest.fn() } as any,
      {
        query: () => ({ findById: jest.fn().mockResolvedValue(invite) }),
      } as any,
      (() => ({
        query: () => ({ findById: jest.fn().mockResolvedValue(fromUser) }),
      })) as any,
    );
    try {
      await expect(
        processor.process({
          data: { fromUserId: 1, inviteId: 2, organizationId: 'o', userId: 1 },
        } as any),
      ).rejects.toBe(smtpDown);
    } finally {
      errorLog.mockRestore();
    }
  });
});
