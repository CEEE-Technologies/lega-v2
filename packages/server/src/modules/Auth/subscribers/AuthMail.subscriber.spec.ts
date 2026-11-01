import { AuthMailSubscriber } from './AuthMail.subscriber';
import { SendResetPasswordMailProcessor } from '../processors/SendResetPasswordMail.processor';
import { SendSignupVerificationMailProcessor } from '../processors/SendSignupVerificationMail.processor';
import InviteSendMainNotificationSubscribe from '@/modules/UsersModule/subscribers/InviteSendMailNotification.subscriber';

const user = {
  id: 7,
  email: 'owner@example.com',
  firstName: 'Priya',
  password: '$2b$10$hashhashhashhashhashhash',
  verifyToken: 'verify-code-123',
};

const SECRET_FIELDS = [
  'token',
  'password',
  'verifyToken',
  'user',
  'invite',
  'fromUser',
];

describe('Mail jobs carry ids only (S4)', () => {
  const queue = () => ({ add: jest.fn().mockResolvedValue({}) });

  it('the reset password job has no reset code or password hash', async () => {
    const resetQueue = queue();
    const subscriber = new AuthMailSubscriber(
      resetQueue as any,
      queue() as any,
    );

    await subscriber.handleSendResetPasswordMail({
      user,
      token: 'reset-code-456',
    } as any);

    const [, data, options] = resetQueue.add.mock.calls[0];
    expect(data).toEqual({ userId: 7 });
    expect(JSON.stringify(data)).not.toContain('reset-code-456');
    expect(JSON.stringify(data)).not.toContain(user.password);
    expect(options.removeOnComplete).toBe(true);
  });

  it('the sign-up verification job has no verification code', async () => {
    const verifyQueue = queue();
    const subscriber = new AuthMailSubscriber(
      queue() as any,
      verifyQueue as any,
    );

    await subscriber.handleSignupSendVerificationMail({ user } as any);

    const [, data, options] = verifyQueue.add.mock.calls[0];
    expect(data).toEqual({ userId: 7 });
    expect(options.removeOnComplete).toBe(true);
  });

  it('the invite job has no invite token', async () => {
    const inviteQueue = queue();
    const tenancyContext = {
      getTenant: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
      getSystemUser: jest.fn().mockResolvedValue({ id: 3 }),
    };
    const subscriber = new InviteSendMainNotificationSubscribe(
      inviteQueue as any,
      tenancyContext as any,
    );
    await subscriber.sendMailNotification({
      invite: { id: 11, token: 'invite-token-789', email: 'new@example.com' },
      user: { id: 5 },
      invitingUser: { id: 2, firstName: 'Priya' },
    } as any);

    const [, data, options] = inviteQueue.add.mock.calls[0];
    expect(data).toEqual({
      fromUserId: 2,
      inviteId: 11,
      userId: 3,
      organizationId: 'org-1',
    });
    for (const field of SECRET_FIELDS) {
      expect(data).not.toHaveProperty(field);
    }
    expect(JSON.stringify(data)).not.toContain('invite-token-789');
    expect(options.removeOnComplete).toBe(true);
  });
});

describe('Mail processors read what they need when they run', () => {
  const chain = (result: any) => {
    const builder: any = {
      findById: jest.fn(() => Promise.resolve(result)),
      where: jest.fn(() => builder),
      orderBy: jest.fn(() => builder),
      first: jest.fn(() => Promise.resolve(result)),
    };
    return { query: () => builder, builder };
  };

  it('the reset password mail uses the newest stored reset code', async () => {
    const mails = {
      sendResetPasswordMail: jest.fn(),
      sendSignupVerificationMail: jest.fn(),
    };
    const users = chain(user);
    const resets = chain({ email: user.email, token: 'reset-code-456' });
    const processor = new SendResetPasswordMailProcessor(
      mails as any,
      {} as any,
      users as any,
      resets as any,
    );
    await processor.process({ data: { userId: 7 } } as any);

    expect(resets.builder.where).toHaveBeenCalledWith('email', user.email);
    expect(mails.sendResetPasswordMail).toHaveBeenCalledWith(
      user,
      'reset-code-456',
    );
  });

  it('skips the mail when the user or code is gone', async () => {
    const mails = { sendResetPasswordMail: jest.fn() };
    const processor = new SendResetPasswordMailProcessor(
      mails as any,
      {} as any,
      chain(undefined) as any,
      chain(undefined) as any,
    );
    await processor.process({ data: { userId: 7 } } as any);
    expect(mails.sendResetPasswordMail).not.toHaveBeenCalled();
  });

  it('the verification mail reads the code from the user', async () => {
    const mails = { sendSignupVerificationMail: jest.fn() };
    const processor = new SendSignupVerificationMailProcessor(
      mails as any,
      {} as any,
      chain(user) as any,
    );
    await processor.process({ data: { userId: 7 } } as any);
    expect(mails.sendSignupVerificationMail).toHaveBeenCalledWith(
      user.email,
      user.firstName,
      'verify-code-123',
    );
  });
});
