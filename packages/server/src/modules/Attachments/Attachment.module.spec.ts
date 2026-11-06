import { MULTER_MODULE_OPTIONS } from '@/common/constants/files.constants';
import { AttachmentsModule } from './Attachment.module';

/**
 * Builds the multer upload options the module registers, with stand-ins for
 * the config, S3 client and request context.
 */
const getUploadStorage = () => {
  const providers: any[] = Reflect.getMetadata('providers', AttachmentsModule);
  const provider = providers.find((p) => p?.provide === MULTER_MODULE_OPTIONS);
  const config = { get: () => 'bucket' };
  const cls = { get: () => 'org-1' };
  return provider.useFactory(config, {}, cls).storage;
};

describe('AttachmentsModule upload storage', () => {
  it('stores uploaded files as private', (done) => {
    const storage = getUploadStorage();
    storage.getAcl({}, {}, (error: Error | null, acl: string) => {
      expect(error).toBeNull();
      expect(acl).toBe('private');
      done();
    });
  });

  it("keys files under the company's folder", (done) => {
    const storage = getUploadStorage();
    storage.getKey({}, {}, (error: Error | null, key: string) => {
      expect(error).toBeNull();
      expect(key).toMatch(/^org-1\/[0-9a-f-]{36}$/);
      done();
    });
  });
});
