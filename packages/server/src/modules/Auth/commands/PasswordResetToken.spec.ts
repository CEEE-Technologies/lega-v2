import { createHash } from 'crypto';
import { AuthSendResetPasswordService } from './AuthSendResetPassword.service';
import { AuthResetPasswordService } from './AuthResetPassword.service';
import { hashPasswordResetToken } from '../Auth.utils';

/**
 * A fake `password_resets` table: just enough of the objection query
 * builder for the two services.
 */
const fakeResetsTable = () => {
  const rows: Array<Record<string, any>> = [];
  const model: any = {
    rows,
    query: () => {
      let filter: (row: any) => boolean = () => true;
      const builder: any = {
        insert: jest.fn(async (row: any) => {
          rows.push({ ...row, createdAt: new Date() });
          return row;
        }),
        where: (column: string, value: any) => {
          filter = (row) => row[column] === value;
          return builder;
        },
        findOne: async (column: string, value: any) =>
          rows.find((row) => row[column] === value),
        delete: async () => {
          for (let i = rows.length - 1; i >= 0; i--) {
            if (filter(rows[i])) rows.splice(i, 1);
          }
        },
      };
      return builder;
    },
  };
  return model;
};

describe('Password reset tokens are stored as hashes', () => {
  const email = 'owner@example.com';
  const user = { id: 7, email };
  const users = () => {
    const update = jest.fn().mockResolvedValue(1);
    return {
      update,
      model: {
        query: () => ({
          findOne: jest.fn().mockResolvedValue(user),
          findById: () => ({ update }),
        }),
      },
    };
  };
  const config = { get: () => 86400 };
  const events = { emitAsync: jest.fn().mockResolvedValue([]) };

  it('hashes with SHA-256', () => {
    expect(hashPasswordResetToken('abc')).toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
  });

  it('stores only the hash and replaces older tokens', async () => {
    const resets = fakeResetsTable();
    const service = new AuthSendResetPasswordService(
      events as any,
      resets,
      users().model as any,
    );
    const first = await service.issueResetToken(email);
    const token = await service.issueResetToken(email);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(resets.rows).toHaveLength(1);
    expect(resets.rows[0]).toEqual(
      expect.objectContaining({
        email,
        tokenHash: hashPasswordResetToken(token),
      }),
    );
    expect(JSON.stringify(resets.rows)).not.toContain(token);
    expect(JSON.stringify(resets.rows)).not.toContain(first);
  });

  it('request then reset: the raw token works once, the hash does not', async () => {
    const resets = fakeResetsTable();
    const sender = new AuthSendResetPasswordService(
      events as any,
      resets,
      users().model as any,
    );
    const token = await sender.issueResetToken(email);
    const storedHash = resets.rows[0].tokenHash;

    const { model, update } = users();
    const resetter = new AuthResetPasswordService(
      config as any,
      events as any,
      model as any,
      resets,
    );
    // The stored hash itself is not a valid reset code.
    await expect(
      resetter.resetPassword(storedHash, 'New-Passw0rd!'),
    ).rejects.toMatchObject({ errorType: 'TOKEN_INVALID' });
    expect(update).not.toHaveBeenCalled();

    await resetter.resetPassword(token, 'New-Passw0rd!');
    expect(update).toHaveBeenCalledTimes(1);
    // The reset raises the session version, which ends older sessions (S10).
    expect(JSON.stringify(update.mock.calls[0][0].sessionVersion)).toContain(
      'session_version + 1',
    );
    expect(resets.rows).toHaveLength(0);

    // Used once: the same link no longer works.
    await expect(
      resetter.resetPassword(token, 'New-Passw0rd!'),
    ).rejects.toMatchObject({ errorType: 'TOKEN_INVALID' });
  });

  it('sending a reset does not put a token in the events', async () => {
    const resets = fakeResetsTable();
    const emitAsync = jest.fn().mockResolvedValue([]);
    const service = new AuthSendResetPasswordService(
      { emitAsync } as any,
      resets,
      users().model as any,
    );
    await service.sendResetPassword(email);

    expect(resets.rows).toHaveLength(0);
    for (const [, payload] of emitAsync.mock.calls) {
      expect(payload).not.toHaveProperty('token');
    }
  });
});
