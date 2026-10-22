import { registerCatalog } from '@orderloop/ui';
import { bn } from './bn';
import { bnAutomation } from './bn.automation';
import { bnDeletion } from './bn.deletion';
import { bnExtra } from './bn.extra';
import { bnMeta } from './bn.meta';
import { bnTikTok } from './bn.tiktok';

// The automation texts go first: a pattern is tried in the order it was added, and theirs are the most specific. The Meta
// ones come next: they hold broad patterns ("{n} items") that must not shadow an automation sentence ("Low stock: {a} items").
// The TikTok texts come first of all: they spell out "TikTok orders" and "{n} waiting orders" before a general "{a} orders" can.
registerCatalog('bn', bnTikTok);
registerCatalog('bn', bnAutomation);
registerCatalog('bn', bnMeta);
registerCatalog('bn', bn);
registerCatalog('bn', bnExtra);
registerCatalog('bn', bnDeletion);
