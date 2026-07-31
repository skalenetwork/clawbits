import { File, UploadTask, UploadType } from 'expo-file-system';
import { useCallback, useRef, useState } from 'react';

import {
  confirmFileUpload,
  requestFileUpload,
  type MmFile,
  type MmFileConfirmBody,
} from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

export interface PendingAttachmentAsset {
  uri: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Image/video pixel width — fed back to confirm. */
  width?: number;
  height?: number;
  durationMs?: number;
}

export type PendingAttachmentStatus =
  | 'preparing'
  | 'uploading'
  | 'confirming'
  | 'done'
  | 'failed';

export interface PendingAttachment {
  /** Stable per-pending id for UI keys; not the server file_id. */
  tempId: string;
  asset: PendingAttachmentAsset;
  status: PendingAttachmentStatus;
  /** 0..1 — upload progress (covers the PUT-to-R2 step only). */
  progress: number;
  /** Set once step 1 returns. */
  fileId?: string;
  /** Set once step 3 returns. */
  file?: MmFile;
  error?: string;
}

interface UseChannelAttachmentsResult {
  attachments: PendingAttachment[];
  addFiles: (assets: PendingAttachmentAsset[]) => void;
  removeFile: (tempId: string) => void;
  reset: () => void;
  /** True when there are pending uploads still in flight. */
  hasInFlight: boolean;
  /** True when at least one attachment exists and all are done. */
  allReady: boolean;
  /** file_ids of confirmed attachments — pass to MmPostRequest.file_ids. */
  readyFileIds: string[];
}

function newTempId(): string {
  return `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function useChannelAttachments(channelId: string): UseChannelAttachmentsResult {
  const { token } = useAuth();
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  // Tracks which tempIds have been removed mid-upload — drop their results.
  const droppedRef = useRef<Set<string>>(new Set());

  const update = useCallback((tempId: string, patch: Partial<PendingAttachment>) => {
    setAttachments((prev) =>
      prev.map((a) => (a.tempId === tempId ? { ...a, ...patch } : a)),
    );
  }, []);

  const removeFile = useCallback((tempId: string) => {
    droppedRef.current.add(tempId);
    setAttachments((prev) => prev.filter((a) => a.tempId !== tempId));
  }, []);

  const runPipeline = useCallback(
    async (tempId: string, asset: PendingAttachmentAsset) => {
      if (!token) {
        update(tempId, { status: 'failed', error: 'Not signed in' });
        return;
      }
      try {
        update(tempId, { status: 'preparing', progress: 0.05 });
        const presign = await requestFileUpload(token, channelId, {
          filename: asset.filename,
          content_type: asset.contentType,
          size_bytes: asset.sizeBytes,
        });
        if (droppedRef.current.has(tempId)) return;
        update(tempId, { fileId: presign.file_id, status: 'uploading', progress: 0.1 });

        await putToPresignedUrl(
          asset.uri,
          presign.upload_url,
          presign.upload_headers,
          (loaded, total) => {
            if (droppedRef.current.has(tempId)) return;
            const frac = total > 0 ? loaded / total : 0;
            update(tempId, { progress: 0.1 + frac * 0.85 });
          },
        );
        if (droppedRef.current.has(tempId)) return;

        update(tempId, { status: 'confirming', progress: 0.97 });
        const confirmBody: MmFileConfirmBody = {};
        if (asset.width != null) confirmBody.width = asset.width;
        if (asset.height != null) confirmBody.height = asset.height;
        if (asset.durationMs != null) confirmBody.duration_ms = asset.durationMs;
        const file = await confirmFileUpload(token, presign.file_id, confirmBody);
        if (droppedRef.current.has(tempId)) return;
        update(tempId, { status: 'done', progress: 1, file });
      } catch (err) {
        if (droppedRef.current.has(tempId)) return;
        update(tempId, {
          status: 'failed',
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    },
    [channelId, token, update],
  );

  const addFiles = useCallback(
    (assets: PendingAttachmentAsset[]) => {
      const newOnes: PendingAttachment[] = assets.map((asset) => ({
        tempId: newTempId(),
        asset,
        status: 'preparing',
        progress: 0,
      }));
      setAttachments((prev) => [...prev, ...newOnes]);
      for (const att of newOnes) {
        void runPipeline(att.tempId, att.asset);
      }
    },
    [runPipeline],
  );

  const reset = useCallback(() => {
    setAttachments((prev) => {
      for (const a of prev) droppedRef.current.add(a.tempId);
      return [];
    });
  }, []);

  const hasInFlight = attachments.some(
    (a) => a.status !== 'done' && a.status !== 'failed',
  );
  const allReady = attachments.length > 0 && attachments.every((a) => a.status === 'done');
  const readyFileIds = attachments
    .filter((a) => a.status === 'done' && a.file)
    .map((a) => a.file!.file_id);

  return { attachments, addFiles, removeFile, reset, hasInFlight, allReady, readyFileIds };
}

async function putToPresignedUrl(
  localUri: string,
  uploadUrl: string,
  headers: Record<string, string>,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  // Stream the file from disk via the native upload task. The previous
  // ``fetch(localUri) → blob → xhr.send(blob)`` path produced a body whose
  // Content-Length didn't always match what R2's presigner pinned, surfacing
  // as opaque 403s. ``UploadTask`` PUTs the raw file bytes and lets the
  // native layer compute Content-Length from the actual file size.
  const task = new UploadTask(new File(localUri), uploadUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers,
    onProgress: ({ bytesSent, totalBytes }) => {
      onProgress(bytesSent, totalBytes);
    },
  });
  const result = await task.uploadAsync();
  if (result.status < 200 || result.status >= 300) {
    const detail = result.body ? `: ${result.body.slice(0, 200)}` : '';
    throw new Error(`Upload failed: HTTP ${result.status}${detail}`);
  }
}
