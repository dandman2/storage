// storageBootstrap.mjs
import supabase from './supabaseClient.mjs';

export async function ensureBucketExists(name) {
  const bucketName = (name || '').trim();
  if (!bucketName) throw new Error('Bucket name is empty');
  const { data: bucket, error } = await supabase.storage.getBucket(bucketName);
  if (bucket) return;
  if (error && String(error.statusCode || error.status) !== '404') throw error;

  const { error: createErr } = await supabase.storage.createBucket(bucketName, {
    public: false,
    fileSizeLimit: '50MB',
    allowedMimeTypes: ['application/x-ndjson', 'text/plain', 'application/json'],
  });
  if (createErr && !/Bucket already exists|Duplicate/i.test(String(createErr.message))) throw createErr;
  console.log(`✅ Bucket '${bucketName}' is ready`);
}
