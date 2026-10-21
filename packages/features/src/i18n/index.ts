import { registerCatalog } from '@orderloop/ui';
import { bn } from './bn';
import { bnAutomation } from './bn.automation';
import { bnExtra } from './bn.extra';

// The automation texts go first: a pattern is tried in the order it was added, and theirs are the most specific.
registerCatalog('bn', bnAutomation);
registerCatalog('bn', bn);
registerCatalog('bn', bnExtra);
