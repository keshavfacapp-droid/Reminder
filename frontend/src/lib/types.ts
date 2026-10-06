export type MessageType = 'text' | 'link' | 'photo' | 'video' | 'document';

export interface Message {
  id: number;
  senderId: number;
  mine: boolean;
  type: MessageType;
  text: string | null;
  file: { name: string; mime: string; size: number; thumb: boolean; display: boolean } | null;
  link: { url: string; host: string; title: string | null; site: string | null } | null;
  createdAt: number;
  readAt: number | null;
}

export type ServerEvent =
  | { type: 'hello' }
  | { type: 'pong' }
  | { type: 'message:new'; message: Message }
  | { type: 'message:updated'; message: Message }
  | { type: 'message:deleted'; id: number }
  | { type: 'message:read'; ids: number[]; readAt: number };

export type UploadKind = 'photo' | 'video' | 'document';
