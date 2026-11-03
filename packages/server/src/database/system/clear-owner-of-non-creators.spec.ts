// The system migrations are plain .js files (loaded from src at run time).
const {
  pickCreator,
} = require('./migrations/20261103120200_clear_owner_of_non_creators.js');

/**
 * The owner migration keeps the same owner health check H7 takes as the
 * creator (DataHealthCheck.getOwnerMemberships), and always keeps one.
 */
describe('clear_owner_of_non_creators: which owner is kept', () => {
  const owner = (userId: number) => ({ userId, email: `u${userId}@x.io` });
  const users = (rows: Array<[number, number, string | null]>) =>
    new Map(
      rows.map(([id, systemUserId, invitedAt]) => [
        systemUserId,
        { id, systemUserId, invitedAt },
      ]),
    );

  it('keeps the owner whose company user came first; invited ones become members', () => {
    const owners = [owner(2), owner(4), owner(1), owner(3)];
    const { keep, clear, allInvited } = pickCreator(
      owners,
      users([
        [10, 1, null],
        [11, 2, '2026-01-01'],
        [12, 3, null],
      ]),
    );
    expect(keep.userId).toBe(1);
    expect(clear.map((o: any) => o.userId).sort()).toEqual([2, 3, 4]);
    expect(allInvited).toBe(false);
  });

  it('an owner with no company user is kept only when it is the only candidate', () => {
    const { keep } = pickCreator(
      [owner(5), owner(6)],
      users([[20, 6, '2026-01-01']]),
    );
    expect(keep.userId).toBe(5);
  });

  it('keeps one owner when every owner looks invited', () => {
    const { keep, clear, allInvited } = pickCreator(
      [owner(5), owner(6)],
      users([
        [21, 6, '2026-01-01'],
        [22, 5, '2026-01-02'],
      ]),
    );
    expect(allInvited).toBe(true);
    expect(keep.userId).toBe(6);
    expect(clear.map((o: any) => o.userId)).toEqual([5]);
  });

  it('a single owner is left alone', () => {
    const { clear } = pickCreator([owner(7)], users([[30, 7, null]]));
    expect(clear).toEqual([]);
  });
});
