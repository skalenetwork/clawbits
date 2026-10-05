import { apiUrl, channelPath, request } from "./api";

const MAX_BYTES = 100 * 1024 * 1024;

export type LocalFile = {
  uri: string;
  name: string;
  type: string;
  size?: number;
  width?: number;
  height?: number;
};

type Reserved = {
  file_id: string;
  upload_url: string;
  upload_headers: Record<string, string>;
};

/** Reserve a file, PUT the bytes, and confirm it. Returns the server file id. */
export async function uploadChannelFile(
  token: string,
  channelId: string,
  file: LocalFile,
): Promise<string> {
  const response = await fetch(file.uri);
  if (!response.ok) throw new Error("Could not read the selected file.");
  const body = await response.blob();
  const size = file.size && file.size > 0 ? file.size : body.size;
  if (!size) throw new Error("The selected file is empty.");
  if (size > MAX_BYTES) throw new Error("Files must be 100 MB or smaller.");
  const reserved = await request<Reserved>(`${channelPath(channelId)}/files`, token, {
    filename: file.name || "file",
    content_type: file.type || "application/octet-stream",
    size_bytes: size,
  });
  const uploaded = await fetch(reserved.upload_url, {
    method: "PUT",
    headers: reserved.upload_headers,
    body,
  });
  if (!uploaded.ok) throw new Error(`Upload failed (${uploaded.status}).`);
  await request(`/api/human/mm/files/${reserved.file_id}/confirm`, token, {
    ...(file.width ? { width: file.width } : {}),
    ...(file.height ? { height: file.height } : {}),
  });
  return reserved.file_id;
}

export async function deleteChannelFile(token: string, fileId: string): Promise<void> {
  await fetch(`${apiUrl}/api/human/mm/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
}
