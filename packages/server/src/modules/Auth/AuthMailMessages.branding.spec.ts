import { existsSync } from 'fs';
import * as path from 'path';
import { AuthenticationMailMesssages } from './AuthMailMessages.esrvice';

describe('LEGA system email branding', () => {
  const originalStatic = global.__static_dirname;
  beforeAll(() => {
    global.__static_dirname = path.resolve(__dirname, '../../../static');
  });
  afterAll(() => {
    global.__static_dirname = originalStatic;
  });

  const service = new AuthenticationMailMesssages(
    { get: () => 'https://example.com' } as any,
    {} as any,
  );

  it('renders reset mail with a resolvable inline LEGA logo and original reset URL', () => {
    const mail = service.resetPasswordMessage(
      {
        email: 'person@example.com',
        firstName: 'Alex',
        lastName: 'Example',
      } as any,
      'test-token',
    );
    expect(mail.subject).toBe('LEGA - Password Reset');
    expect(mail.html).not.toMatch(/bigcapital/i);
    expect(mail.data.resetPasswordUrl).toBe(
      'https://example.com/auth/reset_password/test-token',
    );
    expect(mail.html).toContain(
      'https:&#x2F;&#x2F;example.com&#x2F;auth&#x2F;reset_password&#x2F;test-token',
    );
    const attachment = mail.attachments[0];
    if (!('path' in attachment)) throw new Error('Expected a file attachment');
    expect(existsSync(attachment.path)).toBe(true);
    expect(mail.html).toContain(`cid:${attachment.cid}`);
  });

  it('renders verification mail with the same working inline logo contract', () => {
    const mail = service.signupVerificationMail(
      'person@example.com',
      'Alex Example',
      'test-token',
    );
    expect(mail.subject).toBe('LEGA - Verify your email');
    expect(mail.html).not.toMatch(/bigcapital/i);
    expect(mail.html).toContain('LEGA | Verify your email');
    const attachment = mail.attachments[0];
    if (!('path' in attachment)) throw new Error('Expected a file attachment');
    expect(mail.html).toContain(`cid:${attachment.cid}`);
    expect(existsSync(attachment.path)).toBe(true);
  });
});
