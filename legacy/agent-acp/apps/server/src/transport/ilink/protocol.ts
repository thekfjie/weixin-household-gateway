export interface ILinkBaseInfo {
  channel_version?: string;
}

export const ILinkUploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export type ILinkUploadMediaTypeValue =
  (typeof ILinkUploadMediaType)[keyof typeof ILinkUploadMediaType];

export const ILinkMessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const ILinkMessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const ILinkMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface ILinkCdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface ILinkTextItem {
  text?: string;
}

export interface ILinkFileItem {
  media?: ILinkCdnMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface ILinkImageItem {
  media?: ILinkCdnMedia;
  thumb_media?: ILinkCdnMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
}

export interface ILinkVideoItem {
  media?: ILinkCdnMedia;
  video_size?: number;
  thumb_media?: ILinkCdnMedia;
}

export interface ILinkMessageItem {
  type?: number;
  text_item?: ILinkTextItem;
  file_item?: ILinkFileItem;
  image_item?: ILinkImageItem;
  video_item?: ILinkVideoItem;
}

export interface ILinkMessage {
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: ILinkMessageItem[];
  context_token?: string;
}

export interface ILinkSendMessageRequest {
  msg?: ILinkMessage;
}

export interface ILinkSendMessageResponse {
  ret?: number;
  errmsg?: string;
}

export interface ILinkGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: ILinkMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface ILinkGetUploadUrlRequest {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
}

export interface ILinkGetUploadUrlResponse {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

export interface ILinkQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface ILinkQrCodeStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export interface ILinkGetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface ILinkSendTypingRequest {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}
