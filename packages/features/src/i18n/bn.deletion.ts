/** Bangla for erasing a customer, deleting an account and deleting a business (docs/privacy-and-deletion.md). */
export const bnDeletion: Record<string, string> = {
  // The account page
  'Your account': 'আপনার অ্যাকাউন্ট',
  'Your sign-in, and what happens if you delete it.': 'আপনার সাইন-ইন, এবং এটি মুছে ফেললে কী হয়।',
  'Role here': 'এখানে আপনার ভূমিকা',
  'Delete my account': 'আমার অ্যাকাউন্ট মুছুন',
  'Remove your sign-in and your personal details from OrderLoop.':
    'OrderLoop থেকে আপনার সাইন-ইন ও ব্যক্তিগত তথ্য সরিয়ে ফেলুন।',
  'Deleting your account signs you out everywhere and removes your name, email, password, registered phones and notification settings. It cannot be undone, and you can register the same email again afterwards as a new account. Records your businesses made keep your user id but no longer show your name.':
    'অ্যাকাউন্ট মুছলে আপনি সব জায়গা থেকে সাইন আউট হবেন এবং আপনার নাম, ইমেইল, পাসওয়ার্ড, নিবন্ধিত ফোন ও নোটিফিকেশন সেটিংস সরে যাবে। এটি ফেরানো যায় না; পরে একই ইমেইল দিয়ে নতুন অ্যাকাউন্ট খুলতে পারবেন। আপনার ব্যবসাগুলোর তৈরি রেকর্ডে আপনার ইউজার আইডি থাকবে, কিন্তু আর আপনার নাম দেখা যাবে না।',
  'A business you are the only member of is deleted for good after {days} days, and nobody can cancel that once you are gone. If you are the only owner of a business that has other members, make someone else an owner or remove the other members first.':
    'যে ব্যবসায় আপনি একমাত্র সদস্য, সেটি {days} দিন পর চিরতরে মুছে যাবে, এবং আপনি চলে গেলে কেউ তা বাতিল করতে পারবে না। অন্য সদস্য আছে এমন কোনো ব্যবসার আপনি একমাত্র মালিক হলে, আগে অন্য কাউকে মালিক করুন বা বাকি সদস্যদের সরিয়ে দিন।',
  'Delete your account?': 'আপনার অ্যাকাউন্ট মুছবেন?',
  'Type DELETE to confirm': 'নিশ্চিত করতে DELETE লিখুন',
  'Your password': 'আপনার পাসওয়ার্ড',
  'Businesses that need another owner:': 'যেসব ব্যবসায় আরেকজন মালিক দরকার:',
  'Your account will be deleted and you will be signed out everywhere. It cannot be undone.':
    'আপনার অ্যাকাউন্ট মুছে যাবে এবং আপনি সব জায়গা থেকে সাইন আউট হবেন। এটি ফেরানো যায় না।',
  'Your account was deleted.': 'আপনার অ্যাকাউন্ট মুছে ফেলা হয়েছে।',
  'Your account was deleted. {n} business(es) you were the only member of will be deleted for good.':
    'আপনার অ্যাকাউন্ট মুছে ফেলা হয়েছে। যেসব ব্যবসায় আপনি একমাত্র সদস্য ছিলেন, তার {n}টি চিরতরে মুছে যাবে।',
  'You are the only owner of a business that has other members. Make someone else an owner or remove the other members first, then delete your account.':
    'অন্য সদস্য আছে এমন একটি ব্যবসার আপনি একমাত্র মালিক। আগে অন্য কাউকে মালিক করুন বা বাকি সদস্যদের সরিয়ে দিন, তারপর আপনার অ্যাকাউন্ট মুছুন।',

  // Typed confirmation and password
  'Type {expected} exactly as shown': '{expected} যেমন দেখানো আছে ঠিক তেমন লিখুন',
  'Enter your password': 'আপনার পাসওয়ার্ড দিন',
  'Incorrect password.': 'পাসওয়ার্ড ঠিক নয়।',

  // Deleting a business
  'Delete this business': 'এই ব্যবসা মুছুন',
  'Delete this business?': 'এই ব্যবসা মুছবেন?',
  'Delete the business and everything in it: orders, customers, products, stock, finance records and settings.':
    'ব্যবসা এবং এর সবকিছু মুছে ফেলুন: অর্ডার, গ্রাহক, পণ্য, স্টক, হিসাবের রেকর্ড ও সেটিংস।',
  'Nobody can use the business as soon as you ask. Courier credentials and Meta connections are deleted at once and automation stops. Everything is deleted for good after {days} days; until then you can cancel. Take your data first: the files below are the customer list, orders, products and stock.':
    'আপনি অনুরোধ করামাত্র কেউ আর ব্যবসাটি ব্যবহার করতে পারবে না। কুরিয়ার ক্রেডেনশিয়াল ও Meta সংযোগ সঙ্গে সঙ্গে মুছে যায় এবং অটোমেশন বন্ধ হয়। সবকিছু {days} দিন পর চিরতরে মুছে যায়; তার আগে বাতিল করতে পারবেন। আগে আপনার তথ্য নিয়ে নিন: নিচের ফাইলগুলো গ্রাহক তালিকা, অর্ডার, পণ্য ও স্টকের।',
  'Backups made before the deletion are kept until they expire, and your couriers and Meta keep their own copies, which OrderLoop cannot remove.':
    'মুছে ফেলার আগে নেওয়া ব্যাকআপ মেয়াদ শেষ না হওয়া পর্যন্ত থেকে যায়, এবং আপনার কুরিয়ার ও Meta নিজেদের কপি রেখে দেয়, যা OrderLoop সরাতে পারে না।',
  'Type the business name to confirm': 'নিশ্চিত করতে ব্যবসার নাম লিখুন',
  'Everyone in this business is blocked at once, and it is deleted for good after {days} days. You can cancel until then.':
    'এই ব্যবসার সবাই সঙ্গে সঙ্গে বন্ধ হয়ে যাবেন, এবং {days} দিন পর এটি চিরতরে মুছে যাবে। তার আগে আপনি বাতিল করতে পারবেন।',
  'This business is scheduled for deletion': 'এই ব্যবসা মুছে ফেলার জন্য নির্ধারিত',
  'It will be deleted for good on {date}.': 'এটি {date} তারিখে চিরতরে মুছে যাবে।',
  'Cancel deletion': 'মুছে ফেলা বাতিল করুন',
  'The deletion could not be cancelled. Try again.':
    'মুছে ফেলা বাতিল করা যায়নি। আবার চেষ্টা করুন।',

  // The screen that replaces the app while a business is scheduled for deletion
  '{name} is scheduled for deletion': '{name} মুছে ফেলার জন্য নির্ধারিত',
  'This business is scheduled for deletion on {date}. Nobody can use it until then.':
    'এই ব্যবসা {date} তারিখে মুছে ফেলার জন্য নির্ধারিত। তত দিন কেউ এটি ব্যবহার করতে পারবে না।',
  'You are an owner, so you can cancel the deletion until then. Courier credentials and Meta connections that were deleted when it was requested are not restored: connect them again afterwards, and switch automation back on.':
    'আপনি মালিক, তাই তার আগে মুছে ফেলা বাতিল করতে পারবেন। অনুরোধের সময় যে কুরিয়ার ক্রেডেনশিয়াল ও Meta সংযোগ মুছে গেছে তা ফেরত আসে না: পরে আবার সংযোগ দিন এবং অটোমেশন আবার চালু করুন।',
  'Only an owner of the business can cancel the deletion. Ask them if this was a mistake.':
    'শুধু ব্যবসার মালিক মুছে ফেলা বাতিল করতে পারেন। ভুল হয়ে থাকলে তাকে জানান।',
  'Other businesses': 'অন্যান্য ব্যবসা',
  'You do not belong to another business.': 'আপনি অন্য কোনো ব্যবসার সদস্য নন।',
  'Switch to {name}': '{name}-এ যান',
  'This business is scheduled for deletion, so it cannot be used. Its owner can still cancel the deletion.':
    'এই ব্যবসা মুছে ফেলার জন্য নির্ধারিত, তাই এটি ব্যবহার করা যাবে না। এর মালিক এখনও মুছে ফেলা বাতিল করতে পারেন।',

  // Erasing a customer
  'Personal data': 'ব্যক্তিগত তথ্য',
  'Remove everything that identifies this customer, for example when they ask you to.':
    'এই গ্রাহককে চেনা যায় এমন সবকিছু সরিয়ে ফেলুন, যেমন তিনি অনুরোধ করলে।',
  'Erasing removes the name, phone, email, notes and saved addresses, and the copy of the name, phone and address on every order, in OrderLoop. Order totals, statuses and dates stay, so your accounts still add up. Messages from Facebook or Instagram are deleted too. This cannot be undone.':
    'মুছে ফেললে OrderLoop থেকে নাম, ফোন, ইমেইল, নোট ও সংরক্ষিত ঠিকানা এবং প্রতিটি অর্ডারে থাকা নাম, ফোন ও ঠিকানার কপি সরে যায়। অর্ডারের মোট অঙ্ক, অবস্থা ও তারিখ থেকে যায়, তাই আপনার হিসাব ঠিক থাকে। ফেসবুক বা ইনস্টাগ্রামের বার্তাও মুছে যায়। এটি ফেরানো যায় না।',
  'A customer with an order in progress cannot be erased until it is delivered, cancelled or returned. Couriers and Meta keep their own copies, which OrderLoop cannot remove.':
    'চলমান অর্ডার আছে এমন গ্রাহকের তথ্য ডেলিভারি, বাতিল বা ফেরত না হওয়া পর্যন্ত মোছা যায় না। কুরিয়ার ও Meta নিজেদের কপি রাখে, যা OrderLoop সরাতে পারে না।',
  'Erase personal data': 'ব্যক্তিগত তথ্য মুছুন',
  'Erase this customer’s personal data?': 'এই গ্রাহকের ব্যক্তিগত তথ্য মুছবেন?',
  'Type ERASE to confirm': 'নিশ্চিত করতে ERASE লিখুন',
  'Kept in the audit trail. Do not write other personal details here.':
    'অডিট ট্রেইলে থাকে। এখানে অন্য ব্যক্তিগত তথ্য লিখবেন না।',
  'This customer’s name, phone, email, notes and addresses will be removed everywhere in OrderLoop. It cannot be undone.':
    'এই গ্রাহকের নাম, ফোন, ইমেইল, নোট ও ঠিকানা OrderLoop-এর সব জায়গা থেকে সরে যাবে। এটি ফেরানো যায় না।',
  'Personal data erased': 'ব্যক্তিগত তথ্য মুছে ফেলা হয়েছে',
  'This customer’s personal data was erased on {date}. The name and phone shown are placeholders. Orders keep their totals, statuses and dates.':
    'এই গ্রাহকের ব্যক্তিগত তথ্য {date} তারিখে মুছে ফেলা হয়েছে। এখানে দেখানো নাম ও ফোন শুধু প্লেসহোল্ডার। অর্ডারে মোট অঙ্ক, অবস্থা ও তারিখ থাকে।',
  'Erased customer': 'মুছে ফেলা গ্রাহক',
  'This customer has {n} order(s) in progress. Finish or cancel them first, then erase the customer.':
    'এই গ্রাহকের {n}টি অর্ডার চলমান। আগে সেগুলো শেষ বা বাতিল করুন, তারপর গ্রাহকের তথ্য মুছুন।',
  'This customer’s personal data was erased, so the customer can no longer be changed.':
    'এই গ্রাহকের ব্যক্তিগত তথ্য মুছে ফেলা হয়েছে, তাই গ্রাহককে আর বদলানো যায় না।',

  // Exports
  'Export customers CSV': 'গ্রাহক CSV এক্সপোর্ট করুন',
  'Export orders CSV': 'অর্ডার CSV এক্সপোর্ট করুন',
};
