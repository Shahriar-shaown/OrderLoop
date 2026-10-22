/**
 * Bangla for the TikTok Shop channel: the Integrations page, the TikTok orders list and detail, the SKU mapping, the
 * reservation labels and the error messages. Registered before the other catalogues, so these patterns are tried first (a
 * pattern is matched in the order it was added): "TikTok orders" and "{n} waiting orders" are spelled out because the general
 * "{a} orders" pattern would otherwise take them apart.
 *
 * Wording: a TikTok "SKU" is the product variant TikTok sells; "ম্যাপ" is linking it to one of the shop's own products; "মক"
 * means simulated. Amounts are never translated: they keep their currency code.
 */
export const bnTikTok: Record<string, string> = {
  // Names
  'TikTok orders': 'টিকটক অর্ডার',
  'TikTok order': 'টিকটক অর্ডার',
  'TikTok Shop': 'টিকটক শপ',
  TikTok: 'টিকটক',
  'Facebook and Instagram': 'ফেসবুক ও ইনস্টাগ্রাম',
  'Sales channel': 'বিক্রয়ের চ্যানেল',
  'TikTok orders sections': 'টিকটক অর্ডারের বিভাগ',
  'SKU mapping': 'এসকেইউ ম্যাপিং',
  SKU: 'এসকেইউ',
  'SKU view': 'এসকেইউ দেখার ধরন',
  'Stock state': 'স্টকের অবস্থা',
  Shop: 'শপ',
  Region: 'অঞ্চল',
  'Orders and SKUs': 'অর্ডার ও এসকেইউ',
  'Loading your shops': 'আপনার শপগুলো লোড হচ্ছে',
  'Loading your shops…': 'আপনার শপগুলো লোড হচ্ছে…',
  'Loading SKUs': 'এসকেইউ লোড হচ্ছে',
  'Loading SKUs…': 'এসকেইউ লোড হচ্ছে…',
  'Loading order': 'অর্ডার লোড হচ্ছে',
  'Loading order…': 'অর্ডার লোড হচ্ছে…',

  // The mock notice and the facts every TikTok screen states
  'Mock integration: not connected to TikTok': 'মক ইন্টিগ্রেশন: টিকটকের সাথে যুক্ত নয়',
  'Shops and orders here are simulated for testing. Nothing is sent to or received from TikTok Shop.':
    'এখানকার শপ ও অর্ডার পরীক্ষার জন্য নকল করা। টিকটক শপে কিছু পাঠানো হয় না, সেখান থেকে কিছু আসেও না।',
  'About TikTok Shop in OrderLoop': 'OrderLoop-এ টিকটক শপ সম্পর্কে',
  'OrderLoop only reads TikTok Shop to keep your stock honest. It never changes anything on TikTok: no orders, no products, no stock.':
    'আপনার স্টক সঠিক রাখতে OrderLoop শুধু টিকটক শপ থেকে পড়ে। টিকটকে কখনো কিছু বদলায় না: না অর্ডার, না পণ্য, না স্টক।',
  'Amounts are in the shop’s own currency, not taka. They are never added to your taka totals, revenue or profit.':
    'অঙ্ক শপের নিজের মুদ্রায়, টাকায় নয়। এগুলো কখনো আপনার টাকার মোট, আয় বা মুনাফার সাথে যোগ হয় না।',
  'OrderLoop does not store any buyer details from TikTok.':
    'OrderLoop টিকটক থেকে ক্রেতার কোনো তথ্য সংরক্ষণ করে না।',
  'This connection has not been tested with TikTok yet. Check every figure against your TikTok Seller Center until it has been.':
    'এই সংযোগ এখনো টিকটকের সাথে পরীক্ষা করা হয়নি। পরীক্ষা না হওয়া পর্যন্ত প্রতিটি অঙ্ক আপনার টিকটক সেলার সেন্টারের সাথে মিলিয়ে দেখুন।',
  'Amounts are in {currency}, not taka, and are not part of your taka totals.':
    'অঙ্ক {currency} মুদ্রায়, টাকায় নয়, এবং আপনার টাকার মোটের অংশ নয়।',
  'In the shop’s currency, not taka.': 'শপের মুদ্রায়, টাকায় নয়।',

  // Integrations page
  'Shops on TikTok Shop whose orders OrderLoop mirrors, so your stock stays honest.':
    'টিকটক শপের যেসব শপের অর্ডার OrderLoop নকল করে রাখে, যাতে আপনার স্টক সঠিক থাকে।',
  'Ask an owner or admin if you need to see which shops are connected.':
    'কোন শপ যুক্ত আছে তা দেখতে চাইলে মালিক বা অ্যাডমিনকে বলুন।',
  'Only an owner or admin can connect or change shops. You can see their status.':
    'শুধু মালিক বা অ্যাডমিন শপ যুক্ত বা পরিবর্তন করতে পারেন। আপনি তাদের অবস্থা দেখতে পারবেন।',
  'Could not connect to TikTok Shop': 'টিকটক শপের সাথে যুক্ত করা যায়নি',
  'Connected shops': 'যুক্ত শপ',
  'Connect TikTok Shop': 'টিকটক শপ যুক্ত করুন',
  'Signing in with TikTok is turned off in mock mode. Add a mock shop below to try the flow.':
    'মক মোডে টিকটক দিয়ে সাইন ইন বন্ধ থাকে। প্রক্রিয়াটি দেখতে নিচে একটি মক শপ যোগ করুন।',
  'Connecting to TikTok Shop is not set up on this server yet. Ask whoever runs the server to set it up.':
    'এই সার্ভারে টিকটক শপের সাথে যুক্ত করার ব্যবস্থা এখনো করা হয়নি। যিনি সার্ভার চালান তাকে ব্যবস্থা করতে বলুন।',
  'Signing in with TikTok needs a browser. Open OrderLoop on the web to connect or reconnect a shop. You can see the status, sync and disconnect here.':
    'টিকটক দিয়ে সাইন ইন করতে ব্রাউজার লাগে। শপ যুক্ত বা আবার যুক্ত করতে ওয়েবে OrderLoop খুলুন। এখানে অবস্থা দেখতে, সিঙ্ক করতে ও সংযোগ বিচ্ছিন্ন করতে পারবেন।',
  'No shops connected yet': 'এখনো কোনো শপ যুক্ত নেই',
  'Add a mock shop below to see how TikTok orders keep your stock up to date.':
    'টিকটকের অর্ডার কীভাবে আপনার স্টক হালনাগাদ রাখে দেখতে নিচে একটি মক শপ যোগ করুন।',
  'Connect a TikTok shop to mirror its orders and keep your stock honest.':
    'শপের অর্ডার নকল করে স্টক সঠিক রাখতে একটি টিকটক শপ যুক্ত করুন।',
  'TikTok orders are a separate list: they are not OrderLoop orders and are not in your finance figures.':
    'টিকটক অর্ডার আলাদা তালিকা: এগুলো OrderLoop-এর অর্ডার নয় এবং আপনার আর্থিক হিসাবে নেই।',
  'Orders that need you': 'যে অর্ডারে আপনাকে দরকার',
  'Orders waiting for a product to be mapped: {n}': 'পণ্য ম্যাপের অপেক্ষায় থাকা অর্ডার: {n}',
  'Orders waiting for stock: {n}': 'স্টকের অপেক্ষায় থাকা অর্ডার: {n}',
  'Orders cancelled after shipping, to check: {n}': 'পাঠানোর পরে বাতিল হওয়া অর্ডার, দেখে নিন: {n}',
  'No stock moves for an order until all of its products are mapped.':
    'অর্ডারের সব পণ্য ম্যাপ না হওয়া পর্যন্ত তার জন্য কোনো স্টক নড়ে না।',
  'Open TikTok orders': 'টিকটক অর্ডার খুলুন',
  'Map SKUs ({n} waiting)': 'এসকেইউ ম্যাপ করুন ({n}টি অপেক্ষায়)',
  'Disconnect {name}': '{name} বিচ্ছিন্ন করুন',
  'OrderLoop stops reading orders from this shop and deletes the saved access. Orders and stock already recorded stay as they are. Nothing changes on TikTok. You can connect the shop again later.':
    'OrderLoop এই শপ থেকে অর্ডার পড়া বন্ধ করে এবং সংরক্ষিত অনুমতি মুছে দেয়। যে অর্ডার ও স্টক আগেই লেখা হয়েছে তা যেমন আছে তেমনই থাকে। টিকটকে কিছু বদলায় না। পরে আবার শপটি যুক্ত করতে পারবেন।',
  'Sync now, {name}': 'এখনই সিঙ্ক করুন, {name}',
  'Sync now': 'এখনই সিঙ্ক করুন',
  'Checked again': 'আবার দেখা হয়েছে',
  'Mock shop: waiting orders looked at again: {n}':
    'মক শপ: অপেক্ষায় থাকা অর্ডার আবার দেখা হয়েছে: {n}',
  'Read from TikTok: {a}, changed: {b}, waiting orders looked at again: {c}':
    'টিকটক থেকে পড়া হয়েছে: {a}, বদলেছে: {b}, অপেক্ষায় থাকা অর্ডার আবার দেখা হয়েছে: {c}',
  'More orders remain: sync again.': 'আরও অর্ডার বাকি আছে: আবার সিঙ্ক করুন।',

  // Shops
  'Shop currency: {code}': 'শপের মুদ্রা: {code}',
  'Not synced yet': 'এখনো সিঙ্ক হয়নি',
  'Last synced {when}': 'সর্বশেষ সিঙ্ক {when}',
  'Orders from this shop reach OrderLoop and keep your stock up to date.':
    'এই শপের অর্ডার OrderLoop-এ আসে এবং আপনার স্টক হালনাগাদ রাখে।',
  'TikTok no longer accepts the saved access, for example because it expired or the app was removed. New orders are not arriving until you reconnect.':
    'টিকটক আর সংরক্ষিত অনুমতি মানছে না, যেমন মেয়াদ শেষ হলে বা অ্যাপ সরানো হলে। আবার যুক্ত না করা পর্যন্ত নতুন অর্ডার আসবে না।',
  'A permission was removed or was not approved. Orders may not arrive until you reconnect and approve every permission.':
    'একটি অনুমতি সরানো হয়েছে বা দেওয়া হয়নি। আবার যুক্ত করে প্রতিটি অনুমতি না দিলে অর্ডার নাও আসতে পারে।',
  'This shop is not sending orders. Connect it again to start.':
    'এই শপ থেকে অর্ডার আসছে না। শুরু করতে আবার যুক্ত করুন।',
  'OrderLoop does not know this status yet.': 'OrderLoop এই অবস্থা এখনো চেনে না।',
  'TikTok did not accept the saved access.': 'টিকটক সংরক্ষিত অনুমতি মানেনি।',
  'TikTok says a permission is missing.': 'টিকটক বলছে একটি অনুমতি নেই।',
  'The seller removed OrderLoop from this shop in TikTok.':
    'বিক্রেতা টিকটকে এই শপ থেকে OrderLoop সরিয়ে দিয়েছেন।',
  'TikTok reported a problem with this shop.': 'টিকটক এই শপে একটি সমস্যার কথা জানিয়েছে।',
  'Reconnect from the web app: signing in with TikTok needs a browser.':
    'ওয়েব অ্যাপ থেকে আবার যুক্ত করুন: টিকটক দিয়ে সাইন ইন করতে ব্রাউজার লাগে।',
  'Needs reconnecting': 'আবার যুক্ত করতে হবে',
  'Permission missing': 'অনুমতি নেই',

  // Choosing shops after signing in
  'Choose the shops to connect': 'যুক্ত করার শপ বেছে নিন',
  'Choose the shop you are reconnecting.': 'যে শপটি আবার যুক্ত করছেন সেটি বেছে নিন।',
  'OrderLoop only reads orders from the shops you choose: it never changes anything on TikTok.':
    'আপনার বাছাই করা শপ থেকে OrderLoop শুধু অর্ডার পড়ে: টিকটকে কখনো কিছু বদলায় না।',
  'Some shops could not be connected': 'কিছু শপ যুক্ত করা যায়নি',
  'TikTok did not list any shop you can connect. Make sure you are signed in as the shop owner and try again.':
    'টিকটক আপনার যুক্ত করার মতো কোনো শপ দেখায়নি। শপের মালিক হিসেবে সাইন ইন আছেন কি না দেখে আবার চেষ্টা করুন।',
  'Connected {n} shop': '{n}টি শপ যুক্ত হয়েছে',
  'Connected {n} shops': '{n}টি শপ যুক্ত হয়েছে',
  '{n} other shop was connected.': 'আরও {n}টি শপ যুক্ত হয়েছে।',
  '{n} other shops were connected.': 'আরও {n}টি শপ যুক্ত হয়েছে।',

  // Sign-in and API errors
  'The sign-in with TikTok was cancelled or refused, so nothing was connected.':
    'টিকটক দিয়ে সাইন ইন বাতিল বা প্রত্যাখ্যাত হয়েছে, তাই কিছু যুক্ত হয়নি।',
  'TikTok did not give OrderLoop every permission it needs. Try again and approve every permission.':
    'টিকটক OrderLoop-কে দরকারি সব অনুমতি দেয়নি। আবার চেষ্টা করে প্রতিটি অনুমতি দিন।',
  'TikTok did not accept the sign-in. Try connecting again.':
    'টিকটক সাইন ইন মানেনি। আবার যুক্ত করার চেষ্টা করুন।',
  'TikTok could not be reached right now. Try again in a few minutes.':
    'এখন টিকটকে পৌঁছানো যাচ্ছে না। কয়েক মিনিট পরে আবার চেষ্টা করুন।',
  'TikTok is asking us to slow down. Wait a few minutes and try again.':
    'টিকটক আমাদের ধীর হতে বলছে। কয়েক মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
  'The sign-in with TikTok did not finish. Try connecting again.':
    'টিকটক দিয়ে সাইন ইন শেষ হয়নি। আবার যুক্ত করার চেষ্টা করুন।',
  'Connecting to TikTok Shop is not set up on this server, or this action is not available in its current mode. Ask whoever runs the server.':
    'এই সার্ভারে টিকটক শপের ব্যবস্থা করা নেই, অথবা বর্তমান মোডে এই কাজ চলে না। যিনি সার্ভার চালান তাকে জিজ্ঞাসা করুন।',
  'The sign-in with TikTok expired or is not valid. Start the connection again.':
    'টিকটক দিয়ে সাইন ইনের মেয়াদ শেষ হয়েছে বা তা সঠিক নয়। আবার যুক্ত করা শুরু করুন।',
  'TikTok did not give OrderLoop every permission it needs. Reconnect and approve every permission.':
    'টিকটক OrderLoop-কে দরকারি সব অনুমতি দেয়নি। আবার যুক্ত করে প্রতিটি অনুমতি দিন।',
  'TikTok no longer accepts the saved access. Reconnect the shop.':
    'টিকটক আর সংরক্ষিত অনুমতি মানছে না। শপটি আবার যুক্ত করুন।',
  'TikTok could not be reached. Try again in a few minutes.':
    'টিকটকে পৌঁছানো যায়নি। কয়েক মিনিট পরে আবার চেষ্টা করুন।',
  'That shop is already connected to another business. Disconnect it there first.':
    'সেই শপ ইতিমধ্যে অন্য ব্যবসার সাথে যুক্ত। আগে সেখান থেকে বিচ্ছিন্ন করুন।',
  'This shop could not be connected. Try again.': 'এই শপ যুক্ত করা যায়নি। আবার চেষ্টা করুন।',

  // Mock tools
  'Try it without TikTok': 'টিকটক ছাড়াই চেষ্টা করুন',
  'Add a simulated shop, then send it simulated orders and move them through TikTok’s statuses to see what happens to your stock.':
    'একটি নকল শপ যোগ করুন, তারপর তাতে নকল অর্ডার পাঠিয়ে টিকটকের অবস্থাগুলোতে সরিয়ে দেখুন আপনার স্টকের কী হয়।',
  'Add a mock shop': 'একটি মক শপ যোগ করুন',
  'Add mock shop': 'মক শপ যোগ করুন',
  'Mock shop added': 'মক শপ যোগ করা হয়েছে',
  'Shop name (optional)': 'শপের নাম (ঐচ্ছিক)',
  'Two letters, such as MY.': 'দুটি অক্ষর, যেমন MY।',
  'Three letters, such as MYR.': 'তিনটি অক্ষর, যেমন MYR।',
  'Two letters, for example MY': 'দুটি অক্ষর, যেমন MY',
  'Three letters, for example MYR': 'তিনটি অক্ষর, যেমন MYR',
  Currency: 'মুদ্রা',
  'Send a test order': 'একটি পরীক্ষামূলক অর্ডার পাঠান',
  'Send test order': 'পরীক্ষামূলক অর্ডার পাঠান',
  'Add a mock shop first, then you can send it an order.':
    'আগে একটি মক শপ যোগ করুন, তারপর তাতে অর্ডার পাঠাতে পারবেন।',
  'Send to': 'যাকে পাঠাবেন',
  'The SKU of a product in your catalogue reserves its stock. A SKU OrderLoop does not know waits for you to map it.':
    'আপনার ক্যাটালগের পণ্যের এসকেইউ দিলে তার স্টক রিজার্ভ হয়। OrderLoop যে এসকেইউ চেনে না তা আপনার ম্যাপের অপেক্ষায় থাকে।',
  'Enter a SKU': 'একটি এসকেইউ লিখুন',
  'Enter a whole number from 1 to 10000': '১ থেকে ১০০০০-এর মধ্যে একটি পূর্ণ সংখ্যা লিখুন',
  'Enter an amount such as 12.00, with the right decimals':
    '১২.০০-এর মতো একটি অঙ্ক লিখুন, সঠিক দশমিক সহ',
  'Unit price ({cur})': 'প্রতিটির দাম ({cur})',
  'Order status': 'অর্ডারের অবস্থা',
  'Test orders': 'পরীক্ষামূলক অর্ডার',
  'Test orders you add appear here.': 'আপনার যোগ করা পরীক্ষামূলক অর্ডার এখানে দেখা যাবে।',
  'Order received.': 'অর্ডার পাওয়া গেছে।',
  'Open the order': 'অর্ডারটি খুলুন',
  'This exact notification was already received. Nothing new was created.':
    'এই একই নোটিফিকেশন আগেই পাওয়া গেছে। নতুন কিছু তৈরি হয়নি।',
  'The order was ignored: nothing was stored.': 'অর্ডারটি উপেক্ষা করা হয়েছে: কিছু সংরক্ষণ হয়নি।',
  'The order could not be processed.': 'অর্ডারটি প্রক্রিয়া করা যায়নি।',
  'The order could not be changed. Try again.': 'অর্ডারটি বদলানো যায়নি। আবার চেষ্টা করুন।',
  'Test order {id}': 'পরীক্ষামূলক অর্ডার {id}',
  'Move to {status}, order {id}': '{status} অবস্থায় সরান, অর্ডার {id}',
  'Move to {status}': '{status} অবস্থায় সরান',
  'Cancel order {id}': '{id} অর্ডার বাতিল করুন',
  'Cancel order': 'অর্ডার বাতিল করুন',
  'Order moved to {status}': 'অর্ডার {status} অবস্থায় সরানো হয়েছে',

  Local: 'স্থানীয়',
  'Cross-border': 'আন্তঃসীমান্ত',
  'Fulfilled by seller': 'বিক্রেতা পাঠান',
  'Fulfilled by TikTok': 'টিকটক পাঠায়',
  'Loading reservations': 'রিজার্ভেশন লোড হচ্ছে',
  'Loading reservations…': 'রিজার্ভেশন লোড হচ্ছে…',
  'Order not found': 'অর্ডার পাওয়া যায়নি',
  'Something went wrong on our side. Try again in a moment.':
    'আমাদের দিকে কিছু গোলমাল হয়েছে। একটু পরে আবার চেষ্টা করুন।',

  // Order statuses (TikTok's own)
  Unpaid: 'টাকা দেওয়া হয়নি',
  'Awaiting shipment': 'পাঠানোর অপেক্ষায়',
  'Partly shipping': 'আংশিক পাঠানো হচ্ছে',
  'Awaiting collection': 'সংগ্রহের অপেক্ষায়',
  Completed: 'সম্পন্ন',
  'Buyer can still cancel': 'ক্রেতা এখনো বাতিল করতে পারেন',

  // Stock states and the words that explain them
  'No stock held': 'কোনো স্টক ধরা নেই',
  'Stock reserved': 'স্টক রিজার্ভ করা',
  'Stock shipped': 'স্টক পাঠানো হয়েছে',
  'Stock released': 'স্টক ছাড়া হয়েছে',
  'Needs mapping': 'ম্যাপ করা দরকার',
  'Not enough stock': 'স্টক যথেষ্ট নয়',
  'Needs a look': 'দেখে নেওয়া দরকার',
  'No stock is held for this order.': 'এই অর্ডারের জন্য কোনো স্টক ধরা নেই।',
  'Stock is held for this order. It leaves when TikTok says it shipped.':
    'এই অর্ডারের জন্য স্টক ধরা আছে। টিকটক পাঠানো হয়েছে বললে তা বেরিয়ে যায়।',
  'The order shipped, so its stock has left.': 'অর্ডার পাঠানো হয়েছে, তাই তার স্টক বেরিয়ে গেছে।',
  'The order was cancelled before it shipped, so the stock is available again.':
    'অর্ডারটি পাঠানোর আগে বাতিল হয়েছে, তাই স্টক আবার পাওয়া যাচ্ছে।',
  'A product on this order is not linked to one of yours. No stock has moved.':
    'এই অর্ডারের একটি পণ্য আপনার কোনো পণ্যের সাথে যুক্ত নয়। কোনো স্টক নড়েনি।',
  'Not enough available stock for the whole order. Nothing was reserved.':
    'পুরো অর্ডারের জন্য যথেষ্ট স্টক নেই। কিছুই রিজার্ভ হয়নি।',
  'OrderLoop does not know this stock state yet.': 'OrderLoop এই স্টকের অবস্থা এখনো চেনে না।',
  'Cancelled after it shipped: stock was not changed, check it':
    'পাঠানোর পরে বাতিল হয়েছে: স্টক বদলানো হয়নি, দেখে নিন',
  'Waiting for you to map {n} item: no stock has been moved.':
    'আপনার {n}টি আইটেম ম্যাপের অপেক্ষায়: কোনো স্টক নড়েনি।',
  'Waiting for you to map {n} items: no stock has been moved.':
    'আপনার {n}টি আইটেম ম্যাপের অপেক্ষায়: কোনো স্টক নড়েনি।',
  'There is not enough available stock for the whole order, so nothing was reserved. Receive stock, then press Sync now: OrderLoop also checks again every 10 minutes.':
    'পুরো অর্ডারের জন্য যথেষ্ট স্টক নেই, তাই কিছুই রিজার্ভ হয়নি। স্টক গ্রহণ করে “এখনই সিঙ্ক করুন” চাপুন: OrderLoop প্রতি ১০ মিনিটেও আবার দেখে।',
  'Stock is reserved for this order. It leaves your stock when TikTok says the order has shipped.':
    'এই অর্ডারের জন্য স্টক রিজার্ভ করা আছে। টিকটক অর্ডার পাঠানো হয়েছে বললে তা আপনার স্টক থেকে বেরিয়ে যায়।',
  'The stock shipped with the order and was not given back after the cancellation.':
    'স্টক অর্ডারের সাথে পাঠানো হয়েছে এবং বাতিলের পরে ফেরত দেওয়া হয়নি।',
  'The order has shipped, so its stock has left.':
    'অর্ডার পাঠানো হয়েছে, তাই তার স্টক বেরিয়ে গেছে।',
  'TikTok cancelled the order before it shipped, so the stock that was held is available again.':
    'টিকটক পাঠানোর আগেই অর্ডার বাতিল করেছে, তাই ধরে রাখা স্টক আবার পাওয়া যাচ্ছে।',
  'The order was cancelled before any stock was held.':
    'কোনো স্টক ধরার আগেই অর্ডারটি বাতিল হয়েছে।',
  'The order is not paid yet, so no stock is held.':
    'অর্ডারের টাকা এখনো দেওয়া হয়নি, তাই কোনো স্টক ধরা নেই।',
  'The buyer can still cancel, so no stock is held yet.':
    'ক্রেতা এখনো বাতিল করতে পারেন, তাই এখনো কোনো স্টক ধরা হয়নি।',
  'No stock is held for this order at this status.':
    'এই অবস্থায় এই অর্ডারের জন্য কোনো স্টক ধরা নেই।',
  'OrderLoop does not know this stock state yet, so it shows no explanation.':
    'OrderLoop এই স্টকের অবস্থা এখনো চেনে না, তাই কোনো ব্যাখ্যা দেখাচ্ছে না।',

  // Orders list
  'Orders from your TikTok Shop, copied here so OrderLoop can keep your stock honest. They are in the shop’s own currency, are not OrderLoop orders and are not part of your taka totals. OrderLoop only reads TikTok: it never changes anything there.':
    'আপনার টিকটক শপের অর্ডার এখানে কপি করা হয়েছে, যাতে OrderLoop আপনার স্টক সঠিক রাখতে পারে। এগুলো শপের নিজের মুদ্রায়, OrderLoop-এর অর্ডার নয় এবং আপনার টাকার মোটের অংশ নয়। OrderLoop টিকটক থেকে শুধু পড়ে: সেখানে কখনো কিছু বদলায় না।',
  'Ask an owner or admin if you need to see TikTok orders.':
    'টিকটক অর্ডার দেখতে চাইলে মালিক বা অ্যাডমিনকে বলুন।',
  'All statuses': 'সব অবস্থা',
  'All shops': 'সব শপ',
  'Status: {a}': 'অবস্থা: {a}',
  'Shop: {a}': 'শপ: {a}',
  'Shop: All shops': 'শপ: সব শপ',
  'No TikTok orders here': 'এখানে কোনো টিকটক অর্ডার নেই',
  'Orders arrive from TikTok by themselves: TikTok sends a notification when an order changes, and OrderLoop also checks every 10 minutes. Nothing is changed on TikTok.':
    'অর্ডার টিকটক থেকে নিজে নিজেই আসে: অর্ডার বদলালে টিকটক নোটিফিকেশন পাঠায়, আর OrderLoop প্রতি ১০ মিনিটেও দেখে। টিকটকে কিছু বদলানো হয় না।',
  'Go to the TikTok Shop integration': 'টিকটক শপ ইন্টিগ্রেশনে যান',
  'TikTok order {id}': 'টিকটক অর্ডার {id}',
  'Total (shop currency)': 'মোট (শপের মুদ্রায়)',
  'Last updated': 'সর্বশেষ হালনাগাদ',

  // Order detail
  'A read-only copy of an order on TikTok Shop. Nothing you do here changes anything on TikTok.':
    'টিকটক শপের একটি অর্ডারের শুধু-পড়ার কপি। এখানে আপনি যা-ই করুন, টিকটকে কিছু বদলায় না।',
  Fulfilment: 'ফুলফিলমেন্ট',
  'Placed on TikTok': 'টিকটকে অর্ডার হয়েছে',
  Items: 'আইটেম',
  'Each TikTok product is linked to one of yours by its SKU. No stock moves for an order until all of its items are linked.':
    'প্রতিটি টিকটক পণ্য তার এসকেইউ দিয়ে আপনার একটি পণ্যের সাথে যুক্ত। অর্ডারের সব আইটেম যুক্ত না হওয়া পর্যন্ত তার জন্য কোনো স্টক নড়ে না।',
  'Totals in the shop’s currency': 'শপের মুদ্রায় মোট',
  'Seller discount': 'বিক্রেতার ছাড়',
  'Platform discount': 'প্ল্যাটফর্মের ছাড়',
  Shipping: 'শিপিং',
  Tax: 'কর',
  'Order line {sku}': 'অর্ডারের লাইন {sku}',
  'Seller SKU {a} · TikTok SKU {b}': 'বিক্রেতার এসকেইউ {a} · টিকটক এসকেইউ {b}',
  'No seller SKU · TikTok SKU {b}': 'বিক্রেতার এসকেইউ নেই · টিকটক এসকেইউ {b}',
  'Unnamed TikTok product': 'নামহীন টিকটক পণ্য',
  'OrderLoop product': 'OrderLoop-এর পণ্য',
  'Not mapped': 'ম্যাপ করা হয়নি',
  'Stock held': 'স্টক ধরা আছে',
  'No stock yet': 'এখনো স্টক ধরা হয়নি',
  'This item is not linked to a product. Someone who can change inventory has to map it.':
    'এই আইটেম কোনো পণ্যের সাথে যুক্ত নয়। যিনি ইনভেন্টরি বদলাতে পারেন তাকে এটি ম্যাপ করতে হবে।',

  // SKU mapping
  'TikTok calls each product variant a SKU. OrderLoop links a TikTok SKU to your product when the seller SKU equals your SKU; any other has to be mapped here by a person.':
    'টিকটক প্রতিটি পণ্যের ভ্যারিয়েন্টকে এসকেইউ বলে। বিক্রেতার এসকেইউ আপনার এসকেইউর সমান হলে OrderLoop নিজেই টিকটক এসকেইউকে আপনার পণ্যের সাথে যুক্ত করে; বাকিগুলো এখানে একজনকে ম্যাপ করতে হবে।',
  'Waiting for a link': 'যুক্ত হওয়ার অপেক্ষায়',
  'All SKUs': 'সব এসকেইউ',
  'Nothing to map': 'ম্যাপ করার কিছু নেই',
  'No SKUs yet': 'এখনো কোনো এসকেইউ নেই',
  'Every TikTok SKU seen so far is linked to a product.':
    'এ পর্যন্ত দেখা প্রতিটি টিকটক এসকেইউ একটি পণ্যের সাথে যুক্ত।',
  'A SKU appears here the first time it is on a TikTok order.':
    'টিকটক অর্ডারে প্রথমবার এলে একটি এসকেইউ এখানে দেখা যায়।',
  'TikTok SKU {sku}': 'টিকটক এসকেইউ {sku}',
  '{n} waiting order': '{n}টি অর্ডার অপেক্ষায়',
  '{n} waiting orders': '{n}টি অর্ডার অপেক্ষায়',
  'Linked to': 'যুক্ত আছে',
  'Matched by SKU': 'এসকেইউ মিলিয়ে',
  'Chosen by a person': 'একজন বেছে নিয়েছেন',
  'Not mapped: orders with this SKU wait, and no stock moves for them.':
    'ম্যাপ করা হয়নি: এই এসকেইউর অর্ডারগুলো অপেক্ষা করে এবং তাদের জন্য কোনো স্টক নড়ে না।',
  'Your role can look at SKU links but not change them.':
    'আপনার ভূমিকা এসকেইউ সংযোগ দেখতে পারে, বদলাতে পারে না।',
  'Map to a product': 'পণ্যের সাথে ম্যাপ করুন',
  'Change product': 'পণ্য বদলান',
  'Clear link': 'সংযোগ মুছুন',
  'Use this product': 'এই পণ্যটি নিন',
  'Save mapping': 'ম্যাপ সংরক্ষণ করুন',
  'Choose another': 'অন্যটি বেছে নিন',
  'Map to a product: SKU {sku}': 'পণ্যের সাথে ম্যাপ করুন: এসকেইউ {sku}',
  'Change product, SKU {sku}': 'পণ্য বদলান, এসকেইউ {sku}',
  'Clear link, SKU {sku}': 'সংযোগ মুছুন, এসকেইউ {sku}',
  'Save mapping, SKU {sku}': 'ম্যাপ সংরক্ষণ করুন, এসকেইউ {sku}',
  'Find a product for SKU {sku}': 'এসকেইউ {sku}-এর জন্য পণ্য খুঁজুন',
  'Link cleared': 'সংযোগ মুছে দেওয়া হয়েছে',
  'Mapping saved': 'ম্যাপ সংরক্ষণ করা হয়েছে',
  '{n} waiting order was processed': 'অপেক্ষায় থাকা {n}টি অর্ডার প্রক্রিয়া করা হয়েছে',
  '{n} waiting orders were processed': 'অপেক্ষায় থাকা {n}টি অর্ডার প্রক্রিয়া করা হয়েছে',

  // Reservations of TikTok orders
  'Held by a TikTok order: it is released or shipped by TikTok’s status, not by hand.':
    'টিকটক অর্ডারের জন্য ধরা: এটি টিকটকের অবস্থা অনুযায়ী ছাড়া বা পাঠানো হয়, হাতে নয়।',
  'This reservation belongs to an order. Change the order instead of releasing or fulfilling it here.':
    'এই রিজার্ভেশন একটি অর্ডারের। এখানে ছাড়া বা পূরণ করার বদলে অর্ডারটি বদলান।',
  'Reservations for orders are created by the order itself, not by hand.':
    'অর্ডারের রিজার্ভেশন অর্ডার নিজেই তৈরি করে, হাতে নয়।',
};
