/**
 * Bangla for the Facebook and Instagram integration: the Integrations screen, the social orders inbox and the draft review.
 * Registered before the other catalogues, so these patterns are tried first (a pattern is matched in the order it was added).
 * "Social orders" is spelled out because the general "{a} orders" pattern would otherwise take it apart.
 */
export const bnMeta: Record<string, string> = {
  // Names
  'Social orders': 'সোশ্যাল অর্ডার',
  Integrations: 'ইন্টিগ্রেশন',
  Facebook: 'ফেসবুক',
  Instagram: 'ইনস্টাগ্রাম',
  Mock: 'মক',
  'Review draft': 'ড্রাফট যাচাই',
  'Review draft order': 'ড্রাফট অর্ডার যাচাই করুন',
  'Draft order': 'ড্রাফট অর্ডার',
  'Draft status': 'ড্রাফটের অবস্থা',
  'Needs review': 'যাচাই দরকার',
  Dismissed: 'বাতিল করা হয়েছে',
  'Back to social orders': 'সোশ্যাল অর্ডারে ফিরে যান',
  'Back to Social orders': 'সোশ্যাল অর্ডারে ফিরে যান',
  'Back to integrations': 'ইন্টিগ্রেশনে ফিরে যান',
  'Loading integrations': 'ইন্টিগ্রেশন লোড হচ্ছে',
  'Loading integrations…': 'ইন্টিগ্রেশন লোড হচ্ছে…',
  'Loading your Pages': 'আপনার পেজগুলো লোড হচ্ছে',
  'Loading your Pages…': 'আপনার পেজগুলো লোড হচ্ছে…',
  'Loading draft': 'ড্রাফট লোড হচ্ছে',
  'Loading draft…': 'ড্রাফট লোড হচ্ছে…',

  // The mock notice (always shown where simulated data appears)
  'Mock integration: not connected to Meta': 'মক ইন্টিগ্রেশন: মেটার সাথে যুক্ত নয়',
  'Accounts and messages here are simulated for testing. Nothing is sent to or received from Facebook or Instagram.':
    'এখানকার অ্যাকাউন্ট ও মেসেজ পরীক্ষার জন্য নকল করা। ফেসবুক বা ইনস্টাগ্রামে কিছু পাঠানো হয় না, সেখান থেকে কিছু আসেও না।',

  // Integrations screen
  'Facebook Pages and Instagram accounts whose customer messages become draft orders for you to review. OrderLoop only receives messages: it never replies.':
    'যেসব ফেসবুক পেজ ও ইনস্টাগ্রাম অ্যাকাউন্টের গ্রাহকের মেসেজ আপনার যাচাইয়ের জন্য ড্রাফট অর্ডার হয়ে আসে। OrderLoop শুধু মেসেজ গ্রহণ করে: কখনো উত্তর পাঠায় না।',
  'You do not have access to integrations': 'ইন্টিগ্রেশন দেখার অনুমতি আপনার নেই',
  'Ask an owner or admin if you need to see which accounts are connected.':
    'কোন অ্যাকাউন্ট যুক্ত আছে তা দেখতে চাইলে মালিক বা অ্যাডমিনকে বলুন।',
  'Only an owner or admin can connect or change accounts. You can see their status.':
    'শুধু মালিক বা অ্যাডমিন অ্যাকাউন্ট যুক্ত বা পরিবর্তন করতে পারেন। আপনি তাদের অবস্থা দেখতে পারবেন।',
  'Connected accounts': 'যুক্ত অ্যাকাউন্ট',
  'Connect Facebook & Instagram': 'ফেসবুক ও ইনস্টাগ্রাম যুক্ত করুন',
  'Could not connect to Meta': 'মেটার সাথে যুক্ত করা যায়নি',
  'Signing in with Meta is turned off in mock mode. Add a mock account below to try the flow.':
    'মক মোডে মেটা দিয়ে সাইন ইন বন্ধ থাকে। প্রক্রিয়াটি দেখতে নিচে একটি মক অ্যাকাউন্ট যোগ করুন।',
  'Connecting to Meta is not set up on this server yet. Ask whoever runs the server to set it up.':
    'এই সার্ভারে মেটার সাথে যুক্ত করার ব্যবস্থা এখনো করা হয়নি। যিনি সার্ভার চালান তাকে ব্যবস্থা করতে বলুন।',
  'Connect from the web app': 'ওয়েব অ্যাপ থেকে যুক্ত করুন',
  'Signing in with Meta needs a browser. Open OrderLoop on the web to connect or reconnect an account. You can see the status and disconnect here.':
    'মেটা দিয়ে সাইন ইন করতে ব্রাউজার লাগে। অ্যাকাউন্ট যুক্ত বা আবার যুক্ত করতে ওয়েবে OrderLoop খুলুন। এখানে অবস্থা দেখতে ও সংযোগ বিচ্ছিন্ন করতে পারবেন।',
  'No accounts connected yet': 'এখনো কোনো অ্যাকাউন্ট যুক্ত নেই',
  'Add a mock account below to see how customer messages become draft orders.':
    'গ্রাহকের মেসেজ কীভাবে ড্রাফট অর্ডার হয় দেখতে নিচে একটি মক অ্যাকাউন্ট যোগ করুন।',
  'Connect a Facebook Page, and its Instagram account, to receive customer messages as draft orders.':
    'গ্রাহকের মেসেজ ড্রাফট অর্ডার হিসেবে পেতে একটি ফেসবুক পেজ ও তার ইনস্টাগ্রাম অ্যাকাউন্ট যুক্ত করুন।',
  'Disconnect {name}?': '{name} বিচ্ছিন্ন করবেন?',
  Disconnect: 'বিচ্ছিন্ন করুন',
  'Disconnected {name}': '{name} বিচ্ছিন্ন করা হয়েছে',
  'OrderLoop stops receiving messages from this account and deletes the saved access. Drafts already made stay until they expire. You can connect it again later.':
    'OrderLoop এই অ্যাকাউন্ট থেকে মেসেজ নেওয়া বন্ধ করবে এবং সংরক্ষিত অ্যাক্সেস মুছে ফেলবে। তৈরি হওয়া ড্রাফট মেয়াদ শেষ না হওয়া পর্যন্ত থাকবে। পরে আবার যুক্ত করতে পারবেন।',

  // Connection status
  Reconnect: 'আবার যুক্ত করুন',
  'Reconnect and approve all permissions': 'আবার যুক্ত করুন ও সব অনুমতি দিন',
  'Connect again': 'আবার যুক্ত করুন',
  'Reconnect from the web app: signing in with Meta needs a browser.':
    'ওয়েব অ্যাপ থেকে আবার যুক্ত করুন: মেটা দিয়ে সাইন ইন করতে ব্রাউজার লাগে।',
  'Connected {when}': '{when} যুক্ত হয়েছে',
  'Needs reconnecting': 'আবার যুক্ত করা দরকার',
  'Permission missing': 'অনুমতি নেই',
  Disconnected: 'বিচ্ছিন্ন',
  'Customer messages to this account reach OrderLoop as draft orders.':
    'এই অ্যাকাউন্টে গ্রাহকের পাঠানো মেসেজ OrderLoop-এ ড্রাফট অর্ডার হয়ে আসে।',
  'Meta no longer accepts the saved access, for example after a password change. New messages are not arriving until you reconnect.':
    'মেটা আর সংরক্ষিত অ্যাক্সেস গ্রহণ করছে না, যেমন পাসওয়ার্ড বদলানোর পর। আবার যুক্ত না করা পর্যন্ত নতুন মেসেজ আসবে না।',
  'A permission was removed or was not approved. New messages may not arrive until you reconnect and approve every permission.':
    'একটি অনুমতি তুলে নেওয়া হয়েছে বা দেওয়া হয়নি। আবার যুক্ত করে সব অনুমতি না দেওয়া পর্যন্ত নতুন মেসেজ নাও আসতে পারে।',
  'This account is not receiving messages. Connect it again to start.':
    'এই অ্যাকাউন্টে মেসেজ আসছে না। শুরু করতে আবার যুক্ত করুন।',

  // Coming back from Meta
  'You cancelled the sign-in with Meta, so nothing was connected.':
    'আপনি মেটার সাইন ইন বাতিল করেছেন, তাই কিছু যুক্ত হয়নি।',
  'The sign-in link expired or was already used. Start the connection again from this page.':
    'সাইন ইন লিংকের মেয়াদ শেষ বা আগেই ব্যবহার করা হয়েছে। এই পাতা থেকে আবার যুক্ত করা শুরু করুন।',
  'Meta did not give OrderLoop every permission it needs, or you cannot manage that Page. Try again and approve every permission.':
    'মেটা OrderLoop-কে প্রয়োজনীয় সব অনুমতি দেয়নি, অথবা আপনি ওই পেজ পরিচালনা করতে পারেন না। আবার চেষ্টা করুন এবং সব অনুমতি দিন।',
  'Meta did not accept the sign-in. Try connecting again.':
    'মেটা সাইন ইন গ্রহণ করেনি। আবার যুক্ত করার চেষ্টা করুন।',
  'Meta could not be reached right now. Try again in a few minutes.':
    'এখন মেটায় পৌঁছানো যাচ্ছে না। কয়েক মিনিট পর আবার চেষ্টা করুন।',
  'Meta is asking us to slow down. Wait a few minutes and try again.':
    'মেটা আমাদের ধীর হতে বলছে। কয়েক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
  'The sign-in with Meta did not finish. Try connecting again.':
    'মেটার সাইন ইন শেষ হয়নি। আবার যুক্ত করার চেষ্টা করুন।',
  'Connecting to Meta is not set up on this server. Ask whoever runs the server to set it up.':
    'এই সার্ভারে মেটার সাথে যুক্ত করার ব্যবস্থা করা নেই। যিনি সার্ভার চালান তাকে ব্যবস্থা করতে বলুন।',
  'The sign-in with Meta expired or is not valid. Start the connection again.':
    'মেটার সাইন ইনের মেয়াদ শেষ বা তা সঠিক নয়। আবার যুক্ত করা শুরু করুন।',
  'That Instagram account is not a professional account linked to a Facebook Page.':
    'ওই ইনস্টাগ্রাম অ্যাকাউন্টটি ফেসবুক পেজের সাথে যুক্ত কোনো প্রফেশনাল অ্যাকাউন্ট নয়।',
  'Turn on “Allow access to messages” in the Instagram settings (Messages and story replies, Connected tools), then try again.':
    'ইনস্টাগ্রামের সেটিংসে (মেসেজ ও স্টোরি রিপ্লাই, কানেক্টেড টুলস) “মেসেজে অ্যাক্সেসের অনুমতি” চালু করুন, তারপর আবার চেষ্টা করুন।',
  'That account is already connected to another business. Disconnect it there first.':
    'ওই অ্যাকাউন্ট আগেই অন্য ব্যবসার সাথে যুক্ত আছে। আগে সেখান থেকে বিচ্ছিন্ন করুন।',
  'This account could not be connected. Try again.':
    'এই অ্যাকাউন্ট যুক্ত করা যায়নি। আবার চেষ্টা করুন।',
  'This draft was already confirmed or dismissed. Reload to see what happened.':
    'এই ড্রাফট আগেই নিশ্চিত বা বাতিল করা হয়েছে। কী হয়েছে দেখতে পাতাটি রিলোড করুন।',

  // Choosing Pages
  'Choose the Pages to connect': 'যুক্ত করার পেজ বেছে নিন',
  'Choose the Page you are reconnecting. Its Instagram account is reconnected with it.':
    'যে পেজ আবার যুক্ত করছেন তা বেছে নিন। তার ইনস্টাগ্রাম অ্যাকাউন্টও সাথে যুক্ত হবে।',
  'A Page’s linked Instagram account is connected with it. OrderLoop only receives messages: it never replies.':
    'পেজের সাথে যুক্ত ইনস্টাগ্রাম অ্যাকাউন্টও সাথে যুক্ত হয়। OrderLoop শুধু মেসেজ গ্রহণ করে: কখনো উত্তর পাঠায় না।',
  'Meta did not list any Page you can manage. Make sure you have full control of the Page and try again.':
    'মেটা আপনার পরিচালনার মতো কোনো পেজ দেখায়নি। পেজের পূর্ণ নিয়ন্ত্রণ আপনার আছে কিনা দেখে আবার চেষ্টা করুন।',
  'Instagram @{name}': 'ইনস্টাগ্রাম @{name}',
  'Already connected': 'আগেই যুক্ত',
  'Connect selected': 'বাছাই করাগুলো যুক্ত করুন',
  'Connected {n} account': '{n}টি অ্যাকাউন্ট যুক্ত হয়েছে',
  'Connected {n} accounts': '{n}টি অ্যাকাউন্ট যুক্ত হয়েছে',
  'Some Pages could not be connected': 'কিছু পেজ যুক্ত করা যায়নি',
  '{n} other account was connected.': 'আরও {n}টি অ্যাকাউন্ট যুক্ত হয়েছে।',
  '{n} other accounts were connected.': 'আরও {n}টি অ্যাকাউন্ট যুক্ত হয়েছে।',

  // Mock tools
  'Try it without Meta': 'মেটা ছাড়াই চালিয়ে দেখুন',
  'Add a simulated account, then send a simulated customer message to see how a draft order appears.':
    'একটি নকল অ্যাকাউন্ট যোগ করুন, তারপর একটি নকল গ্রাহক মেসেজ পাঠিয়ে দেখুন ড্রাফট অর্ডার কীভাবে আসে।',
  'Account type': 'অ্যাকাউন্টের ধরন',
  'Facebook Page (mock)': 'ফেসবুক পেজ (মক)',
  'Instagram (mock)': 'ইনস্টাগ্রাম (মক)',
  'Add mock account': 'মক অ্যাকাউন্ট যোগ করুন',
  'Mock account added': 'মক অ্যাকাউন্ট যোগ হয়েছে',
  'Send a test message': 'পরীক্ষামূলক মেসেজ পাঠান',
  'Add a mock account first, then you can send it a message.':
    'আগে একটি মক অ্যাকাউন্ট যোগ করুন, তারপর তাতে মেসেজ পাঠাতে পারবেন।',
  'Send to': 'যাকে পাঠাবেন',
  'Customer message': 'গ্রাহকের মেসেজ',
  'This is a made-up customer message. Change it to try other orders.':
    'এটি বানানো একটি গ্রাহক মেসেজ। অন্য অর্ডার দেখতে এটি বদলান।',
  'Sender id': 'প্রেরকের আইডি',
  'The same sender id continues the same conversation.':
    'একই প্রেরকের আইডি একই কথোপকথন চালিয়ে যায়।',
  'Send test message': 'পরীক্ষামূলক মেসেজ পাঠান',
  'Sending the same text again from the same sender will not create another draft.':
    'একই প্রেরক থেকে একই লেখা আবার পাঠালে আরেকটি ড্রাফট তৈরি হবে না।',
  'Write a message to send': 'পাঠানোর জন্য একটি মেসেজ লিখুন',
  'Enter a sender id': 'প্রেরকের আইডি দিন',
  'Open the draft': 'ড্রাফট খুলুন',
  'This exact message was already received. Nothing new was created.':
    'এই হুবহু মেসেজ আগেই পাওয়া গেছে। নতুন কিছু তৈরি হয়নি।',
  'The message did not look like an order (no phone number, product or order word), so no draft was made.':
    'মেসেজটি অর্ডারের মতো মনে হয়নি (ফোন নম্বর, পণ্য বা অর্ডারের শব্দ নেই), তাই ড্রাফট তৈরি হয়নি।',
  'The message could not be processed.': 'মেসেজটি প্রক্রিয়া করা যায়নি।',
  'The message was received and a draft order is waiting for review.':
    'মেসেজটি পাওয়া গেছে এবং একটি ড্রাফট অর্ডার যাচাইয়ের অপেক্ষায় আছে।',
  'The message was received.': 'মেসেজটি পাওয়া গেছে।',

  // Inbox
  'Orders customers sent as messages on Facebook and Instagram. Check each draft, fix anything that was misread, then confirm it to make the order.':
    'গ্রাহকরা ফেসবুক ও ইনস্টাগ্রামে মেসেজে যেসব অর্ডার পাঠিয়েছেন। প্রতিটি ড্রাফট দেখুন, ভুল পড়া কিছু থাকলে ঠিক করুন, তারপর নিশ্চিত করে অর্ডার তৈরি করুন।',
  'You do not have access to orders': 'অর্ডার দেখার অনুমতি আপনার নেই',
  'Ask an owner or admin if you need to see orders from messages.':
    'মেসেজ থেকে আসা অর্ডার দেখতে চাইলে মালিক বা অ্যাডমিনকে বলুন।',
  'No messages to review': 'যাচাই করার মতো মেসেজ নেই',
  'When a customer messages your connected Facebook Page or Instagram account with an order, a draft appears here for you to check. Nothing is ordered until someone confirms it.':
    'কোনো গ্রাহক আপনার যুক্ত ফেসবুক পেজ বা ইনস্টাগ্রাম অ্যাকাউন্টে অর্ডার পাঠালে এখানে একটি ড্রাফট আসবে, আপনি যাচাই করবেন। কেউ নিশ্চিত না করা পর্যন্ত কিছুই অর্ডার হয় না।',
  'No confirmed drafts yet': 'এখনো কোনো নিশ্চিত ড্রাফট নেই',
  'Drafts that someone confirmed, and the orders they made, are listed here.':
    'যেসব ড্রাফট কেউ নিশ্চিত করেছেন এবং তা থেকে হওয়া অর্ডার এখানে দেখা যাবে।',
  'No dismissed drafts': 'কোনো বাতিল ড্রাফট নেই',
  'Drafts that someone decided not to turn into an order are listed here.':
    'যেসব ড্রাফট কেউ অর্ডার না করার সিদ্ধান্ত নিয়েছেন তা এখানে দেখা যাবে।',
  'Name not found yet': 'নাম এখনো পাওয়া যায়নি',
  'No phone yet': 'এখনো ফোন নম্বর নেই',
  From: 'কোথা থেকে',
  Items: 'আইটেম',
  Messages: 'মেসেজ',
  'Last message': 'শেষ মেসেজ',
  '{n} item': '{n}টি আইটেম',
  '{n} items': '{n}টি আইটেম',
  '{n} to pick': '{n}টির পণ্য বাছাই বাকি',
  'Draft from {name}': '{name}-এর ড্রাফট',
  'Draft from a customer': 'একজন গ্রাহকের ড্রাফট',

  // Review
  'Check what the customer wrote against the form. Nothing is ordered until you confirm.':
    'গ্রাহক যা লিখেছেন তা ফর্মের সাথে মিলিয়ে দেখুন। আপনি নিশ্চিত না করা পর্যন্ত কিছুই অর্ডার হয় না।',
  'What the customer wrote': 'গ্রাহক যা লিখেছেন',
  'Word for word. Check the form below against it.': 'হুবহু। নিচের ফর্ম এর সাথে মিলিয়ে দেখুন।',
  'No messages are stored for this draft.': 'এই ড্রাফটের কোনো মেসেজ সংরক্ষিত নেই।',
  'Attachment: {kinds} (not shown)': 'সংযুক্তি: {kinds} (দেখানো হয়নি)',
  'Check this': 'দেখে নিন',
  'Check this: it was hard to read from the chat.':
    'দেখে নিন: চ্যাট থেকে এটি পড়তে অসুবিধা হয়েছে।',
  'Check before you confirm': 'নিশ্চিত করার আগে দেখে নিন',
  'No phone number was found in the messages. Ask the customer for one.':
    'মেসেজে কোনো ফোন নম্বর পাওয়া যায়নি। গ্রাহকের কাছে চেয়ে নিন।',
  'The customer wrote more than one phone number. Check which one to use.':
    'গ্রাহক একাধিক ফোন নম্বর লিখেছেন। কোনটি ব্যবহার করবেন দেখে নিন।',
  'No delivery address was found. Ask the customer for one.':
    'ডেলিভারির ঠিকানা পাওয়া যায়নি। গ্রাহকের কাছে চেয়ে নিন।',
  'No products were recognised. Add what the customer wants.':
    'কোনো পণ্য চেনা যায়নি। গ্রাহক যা চান তা যোগ করুন।',
  'Some items do not match a product in your catalogue. Pick the product for each one.':
    'কিছু আইটেম আপনার ক্যাটালগের কোনো পণ্যের সাথে মেলেনি। প্রতিটির জন্য পণ্য বেছে নিন।',
  'Some items were matched with low confidence. Check them.':
    'কিছু আইটেম কম নিশ্চয়তায় মেলানো হয়েছে। সেগুলো দেখে নিন।',
  'The customer mentioned a price. It was ignored: prices always come from your catalogue.':
    'গ্রাহক একটি দাম বলেছেন। তা বিবেচনা করা হয়নি: দাম সবসময় আপনার ক্যাটালগ থেকে আসে।',
  'This may repeat an order that already exists. See the list below.':
    'এটি আগে থেকে থাকা কোনো অর্ডারের পুনরাবৃত্তি হতে পারে। নিচের তালিকা দেখুন।',
  'This may repeat an order that already exists':
    'এটি আগে থেকে থাকা কোনো অর্ডারের পুনরাবৃত্তি হতে পারে',
  'This is a different order': 'এটি আলাদা অর্ডার',
  'Tick “This is a different order” above to confirm.':
    'নিশ্চিত করতে ওপরে “এটি আলাদা অর্ডার” টিক দিন।',
  'Pick the product for these items': 'এই আইটেমগুলোর জন্য পণ্য বেছে নিন',
  'Pick the product': 'পণ্য বেছে নিন',
  'Pick the product for “{text}”': '“{text}”-এর জন্য পণ্য বেছে নিন',
  'Find a product for “{text}”': '“{text}”-এর জন্য পণ্য খুঁজুন',
  'Remove “{text}”': '“{text}” সরান',
  'Not matched to a product': 'কোনো পণ্যের সাথে মেলেনি',
  'Pick the product for every item the customer asked for, or remove it.':
    'গ্রাহকের চাওয়া প্রতিটি আইটেমের জন্য পণ্য বেছে নিন, অথবা সরিয়ে দিন।',
  'Customer wrote': 'গ্রাহক লিখেছেন',
  'Save draft': 'ড্রাফট সংরক্ষণ করুন',
  'Draft saved': 'ড্রাফট সংরক্ষিত হয়েছে',
  'Nothing new to save': 'সংরক্ষণ করার মতো নতুন কিছু নেই',
  'Confirming creates the order and holds its stock. Nothing is ordered until you confirm.':
    'নিশ্চিত করলে অর্ডার তৈরি হয় এবং তার স্টক আটকে থাকে। আপনি নিশ্চিত না করা পর্যন্ত কিছুই অর্ডার হয় না।',
  'Dismiss draft': 'ড্রাফট বাতিল করুন',
  'Dismiss this draft?': 'এই ড্রাফট বাতিল করবেন?',
  'Reason (optional)': 'কারণ (ঐচ্ছিক)',
  'Draft dismissed': 'ড্রাফট বাতিল করা হয়েছে',
  'This draft was confirmed': 'এই ড্রাফট নিশ্চিত করা হয়েছে',
  'This draft was dismissed': 'এই ড্রাফট বাতিল করা হয়েছে',
  'Confirmed {when}. It cannot be changed here.':
    '{when} নিশ্চিত করা হয়েছে। এখানে আর বদলানো যাবে না।',
  'It cannot be changed here.': 'এখানে আর বদলানো যাবে না।',
  'Dismissed {when}. No order was made.': '{when} বাতিল করা হয়েছে। কোনো অর্ডার হয়নি।',
  'No order was made.': 'কোনো অর্ডার হয়নি।',
  'Open the order': 'অর্ডার খুলুন',
  'Your role can look at drafts but not confirm or dismiss them. Ask an owner, admin or manager.':
    'আপনার ভূমিকায় ড্রাফট দেখা যায়, কিন্তু নিশ্চিত বা বাতিল করা যায় না। মালিক, অ্যাডমিন বা ম্যানেজারকে বলুন।',
  'Details found in the messages': 'মেসেজে পাওয়া তথ্য',
  'Not found': 'পাওয়া যায়নি',
  'No products were found.': 'কোনো পণ্য পাওয়া যায়নি।',
  '{sku} · {price} each, from your catalogue': '{sku} · প্রতিটি {price}, আপনার ক্যাটালগ থেকে',
  // Small additions to existing forms
  'Customer selected — to do': 'গ্রাহক বাছাই করা — বাকি',
  'Address complete — to do': 'ঠিকানা সম্পূর্ণ — বাকি',
};
