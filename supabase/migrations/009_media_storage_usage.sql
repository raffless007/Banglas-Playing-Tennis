alter table public.media_items
  add column if not exists file_size bigint not null default 0;

update public.media_items as media
set file_size = coalesce((objects.metadata->>'size')::bigint, media.file_size, 0)
from storage.objects as objects
where objects.bucket_id = 'tennis-media'
  and objects.name = media.storage_path
  and coalesce(media.file_size, 0) = 0
  and objects.metadata ? 'size'
  and objects.metadata->>'size' ~ '^[0-9]+$';
