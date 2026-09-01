/** Shared inbound shapes used by channel chat and companion email dispatch. */
export interface InboundFile {
  fileId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

export interface InboundContextPost {
  postId: string;
  senderId: string;
  text: string;
  createAt: number;
  isSelf: boolean;
}

export interface InboundAttachmentMessage {
  postId: string;
  files?: InboundFile[];
}
