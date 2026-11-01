export const giftConfig = {
  recipientName: process.env.NEXT_PUBLIC_RECIPIENT_NAME?.trim() || "you",
  giverName: process.env.NEXT_PUBLIC_GIFT_FROM?.trim() || "Ray",
  productName: process.env.NEXT_PUBLIC_PRODUCT_NAME?.trim() || "Memory",
  message:
    process.env.NEXT_PUBLIC_GIFT_MESSAGE?.trim() ||
    "A little late, but made for you: a place for your notes, your plans, and the memories worth keeping. Happy belated birthday — from Ray.",
  messageZh:
    process.env.NEXT_PUBLIC_GIFT_MESSAGE_ZH?.trim() ||
    "虽然晚了一点，但这是专门为你做的：一个放笔记、计划，以及值得保存的记忆的地方。迟来的生日快乐——Ray。",
};

export const giftStorageKey = "personal-memory-ai-gift-opened";
