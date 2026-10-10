/** A bookmark points to one native conversation item, never a workspace file. */
export type ConversationBookmarkSource = {
  threadId: string;
  turnId: string;
  itemId: string;
  text: string;
  threadName: string;
};

export type BookmarkScope = {
  hostId: string;
  projectPath: string;
};

export type ConversationBookmarkInput = BookmarkScope & {
  name: string;
  source: ConversationBookmarkSource;
};

export type ConversationBookmark = ConversationBookmarkInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
};
