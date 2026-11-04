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

/** The part of a click's A2UI v1.0 action (the server's `UiAction`) the agent reads. */
export interface UiAction {
  name: string;
  sourceComponentId: string;
  context: Record<string, unknown>;
}

/** A human's click on one of the agent's own UI blocks, the post `surfacePostId`. */
export interface InboundUiAction extends UiAction {
  surfacePostId: number;
}

export interface InboundAttachmentMessage {
  postId: string;
  files?: InboundFile[];
}
