/** A message bookmark points to one native conversation item, never a file. */
export type ConversationBookmarkSource = {
  threadId: string;
  turnId: string;
  itemId: string;
  text: string;
  threadName: string;
};

/** Whole-chat bookmarks open the conversation without inventing an item anchor. */
export type ThreadBookmarkSource = {
  threadId: string;
  threadName: string;
};

export type BookmarkScope = {
  hostId: string;
  projectPath: string;
};

export type MessageBookmarkInput = BookmarkScope & {
  name: string;
  /** Older saved message bookmarks omit this field. */
  kind?: 'message';
  source: ConversationBookmarkSource;
};

export type ThreadBookmarkInput = BookmarkScope & {
  name: string;
  kind: 'thread';
  source: ThreadBookmarkSource;
};

export type ConversationBookmarkInput = MessageBookmarkInput | ThreadBookmarkInput;

export type ConversationBookmark = ConversationBookmarkInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
};
