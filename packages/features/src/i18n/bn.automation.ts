/**
 * Bangla for automation, notifications and push. Registered before the other catalogues, so these patterns are tried first
 * (a pattern is matched in the order it was added). The notification texts come from the server in English and are
 * translated here by pattern; every pattern keeps enough fixed words to match only its own sentence.
 */

const text: Record<string, string> = {
  // Kinds
  'New orders': 'নতুন অর্ডার',
  'Orders waiting for confirmation': 'নিশ্চিতকরণের অপেক্ষায় থাকা অর্ডার',
  'Orders running late': 'দেরি হওয়া অর্ডার',
  'Cash on delivery differences': 'ক্যাশ অন ডেলিভারির গরমিল',
  'Daily report': 'দৈনিক রিপোর্ট',
  'Weekly report': 'সাপ্তাহিক রিপোর্ট',
  'Tells you when a product is running low or has run out, so you can reorder in time.':
    'কোনো পণ্যের স্টক কমে গেলে বা শেষ হয়ে গেলে জানায়, যাতে সময়মতো আবার অর্ডার করতে পারেন।',
  'Tells you as soon as an order comes in.': 'অর্ডার আসামাত্র আপনাকে জানায়।',
  'Reminds you about orders that nobody has confirmed yet.':
    'যেসব অর্ডার এখনো কেউ নিশ্চিত করেনি, সেগুলোর কথা মনে করিয়ে দেয়।',
  'Flags orders that are taking too long to be handed to a courier or delivered.':
    'কুরিয়ারকে দিতে বা ডেলিভারি করতে যেসব অর্ডারে বেশি সময় লাগছে, সেগুলো চিহ্নিত করে।',
  'Tells you when a courier statement does not match the cash you expected.':
    'কুরিয়ারের স্টেটমেন্ট আপনার প্রত্যাশিত টাকার সাথে না মিললে জানায়।',
  'A short summary of today at the time you choose.':
    'আপনার বেছে নেওয়া সময়ে আজকের একটি সংক্ষিপ্ত সারাংশ।',
  'A summary of the last 7 days on the day and at the time you choose.':
    'আপনার বেছে নেওয়া দিনে ও সময়ে গত ৭ দিনের সারাংশ।',

  // Channels and statuses
  'In the app': 'অ্যাপে',
  'Push to phones': 'ফোনে পুশ',
  'Push to my phone': 'আমার ফোনে পুশ',
  Push: 'পুশ',
  SMS: 'এসএমএস',
  WhatsApp: 'হোয়াটসঅ্যাপ',
  'Waiting to run': 'চলার অপেক্ষায়',
  Running: 'চলছে',
  Failed: 'ব্যর্থ',
  'Nobody to tell': 'জানানোর কেউ নেই',
  Off: 'বন্ধ',
  Sunday: 'রবিবার',
  Monday: 'সোমবার',
  Tuesday: 'মঙ্গলবার',
  Wednesday: 'বুধবার',
  Thursday: 'বৃহস্পতিবার',
  Friday: 'শুক্রবার',
  Saturday: 'শনিবার',

  // Rule settings
  'Alert when stock is at or below': 'স্টক এই পর্যন্ত বা এর নিচে নামলে জানান',
  'Each product’s own reorder point': 'প্রতিটি পণ্যের নিজস্ব রিঅর্ডার পয়েন্ট',
  'The same number for every product': 'সব পণ্যের জন্য একই সংখ্যা',
  'A reorder point of 0 means that product never alerts.':
    'রিঅর্ডার পয়েন্ট ০ হলে ওই পণ্যের জন্য কখনো সতর্কতা আসবে না।',
  'Number of units': 'পণ্যের সংখ্যা',
  'Also alert for products that are completely out of stock':
    'যেসব পণ্যের স্টক পুরোপুরি শেষ, সেগুলোর জন্যও জানান',
  'First reminder after (minutes)': 'প্রথম রিমাইন্ডার (কত মিনিট পরে)',
  'Remind again every (minutes, optional)': 'আবার মনে করান প্রতি (মিনিট, ঐচ্ছিক)',
  'Leave empty for one reminder. An order is reminded about at most 3 times.':
    'একবার মনে করাতে চাইলে খালি রাখুন। একটি অর্ডারের কথা সর্বোচ্চ ৩ বার মনে করানো হয়।',
  'Running late after (hours)': 'দেরি ধরা হবে (কত ঘণ্টা পরে)',
  'Counted from when the order was confirmed or shipped.':
    'অর্ডার নিশ্চিত বা শিপ করার সময় থেকে গণনা করা হয়।',
  'Ignore differences smaller than (৳, optional)': 'এর চেয়ে কম গরমিল উপেক্ষা করুন (৳, ঐচ্ছিক)',
  'Leave empty to be told about every difference.': 'প্রতিটি গরমিলের কথা জানতে চাইলে খালি রাখুন।',
  'Send at': 'পাঠানোর সময়',
  'Send on': 'পাঠানোর দিন',
  'In 24-hour time, for example 20:00.': '২৪ ঘণ্টার সময়ে, যেমন 20:00।',
  'Use 24-hour time such as 20:00.': '২৪ ঘণ্টার সময় লিখুন, যেমন 20:00।',
  'Enter a whole number from {a} to {b}.': '{a} থেকে {b} পর্যন্ত একটি পূর্ণসংখ্যা লিখুন।',
  'Enter an amount from 0 to {a}.': '০ থেকে {a} পর্যন্ত একটি অঙ্ক লিখুন।',
  'Times are in your business time zone: {a}.': 'সময় আপনার ব্যবসার টাইম জোন অনুযায়ী: {a}।',

  // Automation screen
  Automation: 'অটোমেশন',
  'Choose which alerts OrderLoop sends for this business, when, and how. Each person can still turn channels off for themselves.':
    'এই ব্যবসার জন্য OrderLoop কোন সতর্কতা, কখন ও কীভাবে পাঠাবে তা বেছে নিন। প্রত্যেকে নিজের জন্য চ্যানেল বন্ধ করতে পারবেন।',
  'Only an owner or admin can change automation. You can see how it is set up.':
    'শুধু মালিক বা অ্যাডমিন অটোমেশন বদলাতে পারেন। কীভাবে সাজানো আছে তা আপনি দেখতে পারেন।',
  'Push is in test mode on this server': 'এই সার্ভারে পুশ টেস্ট মোডে আছে',
  'Push alerts are recorded but not delivered to phones until the server is set up for it.':
    'সার্ভার ঠিকভাবে সেট না হওয়া পর্যন্ত পুশ সতর্কতা শুধু রেকর্ড হয়, ফোনে পৌঁছায় না।',
  'You do not have access to automation': 'অটোমেশনে আপনার প্রবেশাধিকার নেই',
  'Ask an owner or admin if you need to see how alerts are set up. You can still choose which alerts you receive in Notification preferences.':
    'সতর্কতা কীভাবে সাজানো আছে তা দেখতে চাইলে মালিক বা অ্যাডমিনকে বলুন। কোন সতর্কতা পাবেন তা নোটিফিকেশন পছন্দ থেকে বেছে নিতে পারবেন।',
  'Loading automation': 'অটোমেশন লোড হচ্ছে',
  'Loading automation…': 'অটোমেশন লোড হচ্ছে…',
  'Nothing to show.': 'দেখানোর কিছু নেই।',
  'Switched on': 'চালু আছে',
  'Not set up yet': 'এখনো সেট করা হয়নি',
  'Send through': 'যেভাবে পাঠানো হবে',
  'Goes to team members who can see stock. Each person can also turn channels off for themselves.':
    'যেসব সদস্য স্টক দেখতে পারেন তাদের কাছে যায়। প্রত্যেকে নিজের জন্য চ্যানেল বন্ধও করতে পারেন।',
  'Goes to team members who can see orders. Each person can also turn channels off for themselves.':
    'যেসব সদস্য অর্ডার দেখতে পারেন তাদের কাছে যায়। প্রত্যেকে নিজের জন্য চ্যানেল বন্ধও করতে পারেন।',
  'Goes to team members who can see finances. Each person can also turn channels off for themselves.':
    'যেসব সদস্য আর্থিক হিসাব দেখতে পারেন তাদের কাছে যায়। প্রত্যেকে নিজের জন্য চ্যানেল বন্ধও করতে পারেন।',
  Saved: 'সংরক্ষিত হয়েছে',
  'Run now': 'এখনই চালান',
  'Save and switch this rule on to run it now.': 'এখনই চালাতে এই নিয়মটি সংরক্ষণ করে চালু করুন।',
  'The run failed': 'চালানো ব্যর্থ হয়েছে',
  'No details were recorded.': 'কোনো বিবরণ রেকর্ড হয়নি।',
  'Nothing was sent: nobody is set to receive this alert. Check Notification preferences.':
    'কিছুই পাঠানো হয়নি: এই সতর্কতা পাওয়ার জন্য কেউ ঠিক করা নেই। নোটিফিকেশন পছন্দ দেখে নিন।',
  'Run finished': 'চালানো শেষ হয়েছে',
  'New notifications: {a}. Skipped (already told or not needed): {b}.':
    'নতুন নোটিফিকেশন: {a}। বাদ গেছে (আগেই জানানো হয়েছে বা দরকার নেই): {b}।',
  'Last run: {a}': 'সর্বশেষ চালানো: {a}',
  'New: {a}, skipped: {b}': 'নতুন: {a}, বাদ: {b}',
  'It has not run yet.': 'এটি এখনো চালানো হয়নি।',
  'Recent runs and problems': 'সাম্প্রতিক চালানো ও সমস্যা',
  'Runs and deliveries that failed. Trying one again never sends anything twice.':
    'যেসব চালানো ও পাঠানো ব্যর্থ হয়েছে। আবার চেষ্টা করলে কিছু দুবার যাবে না।',
  'Nothing has failed recently. Everything that ran was delivered.':
    'সম্প্রতি কিছু ব্যর্থ হয়নি। যা চলেছে সবই পৌঁছে গেছে।',
  '{a}: the check did not finish': '{a}: যাচাই শেষ হয়নি',
  '{a}: {b} not delivered': '{a}: {b} পৌঁছায়নি',
  Retry: 'আবার চেষ্টা',
  'Queued to try again': 'আবার চেষ্টার জন্য লাইনে রাখা হয়েছে',
  'Tried 1 time': '১ বার চেষ্টা হয়েছে',
  'Tried {n} times': '{n} বার চেষ্টা হয়েছে',
  'It cannot be delivered:': 'এটি পৌঁছানো যাবে না:',
  'A temporary problem:': 'সাময়িক সমস্যা:',
  'Loading problems': 'সমস্যার তালিকা লোড হচ্ছে',
  'Loading problems…': 'সমস্যার তালিকা লোড হচ্ছে…',
  'Cannot reach the server. Check your connection and try again.':
    'সার্ভারে পৌঁছানো যাচ্ছে না। আপনার সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।',
  'This server cannot send that kind of message yet. Turn the channel off, or ask whoever runs the server to set it up.':
    'এই সার্ভার এখনো ওই ধরনের বার্তা পাঠাতে পারে না। চ্যানেলটি বন্ধ করুন, অথবা যিনি সার্ভার চালান তাকে সেট করতে বলুন।',
  'Nobody who would get this alert has agreed to SMS or WhatsApp yet. Each person agrees in Notification preferences first.':
    'যারা এই সতর্কতা পাবেন তাদের কেউ এখনো এসএমএস বা হোয়াটসঅ্যাপে রাজি হননি। প্রত্যেকে আগে নোটিফিকেশন পছন্দ থেকে রাজি হবেন।',

  // Notifications
  Notifications: 'নোটিফিকেশন',
  'Notifications, {n} unread': 'নোটিফিকেশন, {n}টি অপঠিত',
  'Mark all read': 'সব পড়া হয়েছে চিহ্নিত করুন',
  Preferences: 'পছন্দ',
  'Alerts about your stock, orders, cash on delivery and reports.':
    'আপনার স্টক, অর্ডার, ক্যাশ অন ডেলিভারি ও রিপোর্টের সতর্কতা।',
  'You are all caught up': 'সবকিছু দেখা হয়ে গেছে',
  'New alerts appear here when something needs your attention.':
    'কিছুতে আপনার নজর দরকার হলে নতুন সতর্কতা এখানে আসবে।',
  'Loading notifications': 'নোটিফিকেশন লোড হচ্ছে',
  'Loading notifications…': 'নোটিফিকেশন লোড হচ্ছে…',
  New: 'নতুন',
  'New notification': 'নতুন নোটিফিকেশন',
  'New notification: {a}': 'নতুন নোটিফিকেশন: {a}',
  'Get alerts on this phone': 'এই ফোনে সতর্কতা পান',
  'Not now': 'এখন নয়',
  'We can tell you when stock runs low or an order needs you, even when the app is closed. You can change this any time in Notification preferences.':
    'স্টক কমে গেলে বা কোনো অর্ডারে আপনাকে দরকার হলে, অ্যাপ বন্ধ থাকলেও আমরা জানাতে পারি। নোটিফিকেশন পছন্দ থেকে যেকোনো সময় এটি বদলাতে পারবেন।',
  'This phone': 'এই ফোন',
  'Alerts that arrive on this phone while the app is closed. Which alerts you get is chosen below.':
    'অ্যাপ বন্ধ থাকলেও এই ফোনে আসা সতর্কতা। কোন সতর্কতা পাবেন তা নিচে বেছে নিন।',
  'Alerts are on for this phone.': 'এই ফোনে সতর্কতা চালু আছে।',
  'Notifications are off for OrderLoop in your phone’s settings. Turn them on there to get alerts on this phone.':
    'আপনার ফোনের সেটিংসে OrderLoop-এর নোটিফিকেশন বন্ধ আছে। এই ফোনে সতর্কতা পেতে সেখানে চালু করুন।',
  'Turn on alerts': 'সতর্কতা চালু করুন',

  // Preferences and consent
  'Notification preferences': 'নোটিফিকেশন পছন্দ',
  'Choose how you hear about each kind of alert. These choices are yours alone and apply to this business.':
    'প্রতিটি ধরনের সতর্কতা আপনি কীভাবে জানবেন তা বেছে নিন। এই পছন্দ শুধু আপনার এবং এই ব্যবসার জন্য।',
  'Your alerts': 'আপনার সতর্কতা',
  'Switching a channel off here stops it for you, even when the business has it on.':
    'এখানে কোনো চ্যানেল বন্ধ করলে ব্যবসা সেটি চালু রাখলেও আপনার জন্য বন্ধ হয়ে যাবে।',
  'Loading your preferences': 'আপনার পছন্দ লোড হচ্ছে',
  'Loading your preferences…': 'আপনার পছন্দ লোড হচ্ছে…',
  'Your role does not receive this alert, so these choices have no effect.':
    'আপনার ভূমিকা এই সতর্কতা পায় না, তাই এই পছন্দগুলোর কোনো প্রভাব নেই।',
  'Text and WhatsApp alerts': 'টেক্সট ও হোয়াটসঅ্যাপ সতর্কতা',
  'Alerts are sent by SMS or WhatsApp only to people who agree here, and only to the number they give. You can stop at any time.':
    'এসএমএস বা হোয়াটসঅ্যাপে সতর্কতা শুধু তাদেরই পাঠানো হয় যারা এখানে রাজি হন, এবং শুধু তাদের দেওয়া নম্বরে। যেকোনো সময় বন্ধ করতে পারবেন।',
  'You agreed': 'আপনি রাজি হয়েছেন',
  'Not agreed': 'রাজি হননি',
  'Alerts go to {a}.': 'সতর্কতা যাবে {a} নম্বরে।',
  'Alerts go to the number you gave.': 'আপনার দেওয়া নম্বরে সতর্কতা যাবে।',
  'Stop {a} alerts': '{a} সতর্কতা বন্ধ করুন',
  'Your {a} number': 'আপনার {a} নম্বর',
  'A Bangladeshi mobile number, for example 01712 345678.':
    'একটি বাংলাদেশি মোবাইল নম্বর, যেমন 01712 345678।',
  'Enter your mobile number, for example 01712 345678.':
    'আপনার মোবাইল নম্বর লিখুন, যেমন 01712 345678।',
  'Agree to get {a} alerts': '{a} সতর্কতা পেতে রাজি',
  'You will get {a} alerts.': 'আপনি {a} সতর্কতা পাবেন।',
  'You will not get {a} alerts.': 'আপনি {a} সতর্কতা পাবেন না।',
  'Loading your choices': 'আপনার পছন্দ লোড হচ্ছে',
  'Loading your choices…': 'আপনার পছন্দ লোড হচ্ছে…',
  'Choose which alerts you get and where. Owners and admins set up what the business sends.':
    'কোন সতর্কতা কোথায় পাবেন তা বেছে নিন। ব্যবসা কী পাঠাবে তা মালিক ও অ্যাডমিন ঠিক করেন।',

  // What the server writes in a notification
  'Low stock: 1 item': 'স্টক কম: ১টি পণ্য',
  'Low stock: {n} items': 'স্টক কম: {n}টি পণ্য',
  'New order #{n}': 'নতুন অর্ডার #{n}',
  '{n} new orders': '{n}টি নতুন অর্ডার',
  '1 order waiting for confirmation': '১টি অর্ডার নিশ্চিতকরণের অপেক্ষায়',
  '{n} orders waiting for confirmation': '{n}টি অর্ডার নিশ্চিতকরণের অপেক্ষায়',
  '1 order running late': '১টি অর্ডার দেরিতে চলছে',
  '{n} orders running late': '{n}টি অর্ডার দেরিতে চলছে',
  '1 COD discrepancy to review': '১টি ক্যাশ অন ডেলিভারির গরমিল দেখার আছে',
  '{n} COD discrepancies to review': '{n}টি ক্যাশ অন ডেলিভারির গরমিল দেখার আছে',
  'Daily report {a}': 'দৈনিক রিপোর্ট {a}',
  'Weekly report {a} to {b}': 'সাপ্তাহিক রিপোর্ট {a} থেকে {b}',
  'Order #{n} came in.': 'অর্ডার #{n} এসেছে।',
  'Order #{n} came in with 1 item (via {s}).': 'অর্ডার #{n} এসেছে, ১টি পণ্য ({s} থেকে)।',
  'Order #{n} came in with {k} items (via {s}).': 'অর্ডার #{n} এসেছে, {k}টি পণ্য ({s} থেকে)।',
  facebook: 'ফেসবুক',
  instagram: 'ইনস্টাগ্রাম',
  whatsapp: 'হোয়াটসঅ্যাপ',
  'phone call': 'ফোন কল',
  website: 'ওয়েবসাইট',
  'walk in': 'সরাসরি দোকানে',
  'A cash on delivery difference needs review.': 'একটি ক্যাশ অন ডেলিভারির গরমিল দেখা দরকার।',
};

const BN_ONE = '১';
type Entry = [string, string];

/** `{a}` is a list of order numbers ("#1, #2"), with or without a count of the rest ("#1, #2 and 3 more"). */
const lists = (head: (list: string) => Entry): Entry[] => {
  const [withMoreKey, withMoreValue] = head('{a} and {m} more');
  const [plainKey, plainValue] = head('{a}');
  return [
    [withMoreKey, withMoreValue.replace('{a} and {m} more', '{a} এবং আরও {m}টি')],
    [plainKey, plainValue],
  ];
};

const patterns: Entry[] = [
  ...lists((l) => [`${l} came in.`, `${l} এসেছে।`]),
  ...['has', 'have'].flatMap((verb) =>
    ['minutes', 'hours'].flatMap((unit) =>
      lists((l) => [
        `${l} ${verb} been waiting more than {w} ${unit}.`,
        `${l} {w} ${unit === 'hours' ? 'ঘণ্টার' : 'মিনিটের'} বেশি সময় ধরে অপেক্ষায় আছে।`,
      ]),
    ),
  ),
  ...['is', 'are'].flatMap((verb) =>
    lists((l) => [
      `${l} ${verb} not delivered {h} hours after being confirmed or shipped.`,
      `${l} নিশ্চিত বা শিপ করার {h} ঘণ্টা পরও ডেলিভারি হয়নি।`,
    ]),
  ),
  ...lists((l) => [
    `A cash on delivery difference needs review: ${l}.`,
    `একটি ক্যাশ অন ডেলিভারির গরমিল দেখা দরকার: ${l}।`,
  ]),
  ['{n} cash on delivery differences need review.', '{n}টি ক্যাশ অন ডেলিভারির গরমিল দেখা দরকার।'],
  ...lists((l) => [
    `{n} cash on delivery differences need review: ${l}.`,
    `{n}টি ক্যাশ অন ডেলিভারির গরমিল দেখা দরকার: ${l}।`,
  ]),
];

/** The report's second sentence names counts that may be one or many: one pattern for each combination. */
const COUNTS: { key: [string, string]; value: [string, string] }[] = [
  { key: ['{a} orders', '1 order'], value: ['{a}টি অর্ডার', `${BN_ONE}টি অর্ডার`] },
  {
    key: ['{e} items low on stock', '1 item low on stock'],
    value: ['{e}টি পণ্যের স্টক কম', `${BN_ONE}টি পণ্যের স্টক কম`],
  },
  {
    key: ['{f} open COD discrepancies', '1 open COD discrepancy'],
    value: ['{f}টি খোলা গরমিল', `${BN_ONE}টি খোলা গরমিল`],
  },
];
const reports: Entry[] = [0, 1].flatMap((o) =>
  [0, 1].flatMap((l) =>
    [0, 1].map((d): Entry => {
      const key = (i: number, n: number) => COUNTS[i]!.key[n]!;
      const value = (i: number, n: number) => COUNTS[i]!.value[n]!;
      return [
        `${key(0, o)}, revenue {b}, {c} delivered, {d} cancelled. ${key(1, l)}, ${key(2, d)}.`,
        `${value(0, o)}, আয় {b}, ডেলিভারি হয়েছে {c}টি, বাতিল {d}টি। ${value(1, l)}, ${value(2, d)}।`,
      ];
    }),
  ),
);

export const bnAutomation: Record<string, string> = {
  ...text,
  ...Object.fromEntries(patterns),
  ...Object.fromEntries(reports),
};
