export interface InboundWechatMessage {
  wechatAccountId: string;
  contactId: string;
  text: string;
  receivedAt: string;
}

export interface OutboundTextMessage {
  wechatAccountId: string;
  contactId: string;
  text: string;
}

export interface OutboundFileMessage {
  wechatAccountId: string;
  contactId: string;
  localPath: string;
  fileName: string;
}
