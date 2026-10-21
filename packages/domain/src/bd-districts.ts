import type { Division } from '@orderloop/contracts';

/** Bangladesh's 64 districts with their division, an English spelling and the common alternates and Bangla names people write. */
interface DistrictEntry {
  name: string;
  division: Division;
  aliases: readonly string[];
}

const d = (name: string, division: Division, ...aliases: string[]): DistrictEntry => ({
  name,
  division,
  aliases,
});

export const BD_DISTRICTS: readonly DistrictEntry[] = [
  d('Barguna', 'Barishal', 'বরগুনা'),
  d('Barishal', 'Barishal', 'Barisal', 'বরিশাল'),
  d('Bhola', 'Barishal', 'ভোলা'),
  d('Jhalokati', 'Barishal', 'Jhalakathi', 'ঝালকাঠি'),
  d('Patuakhali', 'Barishal', 'পটুয়াখালী'),
  d('Pirojpur', 'Barishal', 'পিরোজপুর'),
  d('Bandarban', 'Chattogram', 'বান্দরবান'),
  d('Brahmanbaria', 'Chattogram', 'ব্রাহ্মণবাড়িয়া'),
  d('Chandpur', 'Chattogram', 'চাঁদপুর'),
  d('Chattogram', 'Chattogram', 'Chittagong', 'Chattagram', 'চট্টগ্রাম'),
  d('Cumilla', 'Chattogram', 'Comilla', 'কুমিল্লা'),
  d("Cox's Bazar", 'Chattogram', 'Coxs Bazar', 'Cox Bazar', 'Coxbazar', 'কক্সবাজার'),
  d('Feni', 'Chattogram', 'ফেনী'),
  d('Khagrachhari', 'Chattogram', 'Khagrachari', 'খাগড়াছড়ি'),
  d('Lakshmipur', 'Chattogram', 'Laxmipur', 'লক্ষ্মীপুর'),
  d('Noakhali', 'Chattogram', 'নোয়াখালী'),
  d('Rangamati', 'Chattogram', 'রাঙ্গামাটি'),
  d('Dhaka', 'Dhaka', 'Dacca', 'ঢাকা'),
  d('Faridpur', 'Dhaka', 'ফরিদপুর'),
  d('Gazipur', 'Dhaka', 'গাজীপুর'),
  d('Gopalganj', 'Dhaka', 'গোপালগঞ্জ'),
  d('Kishoreganj', 'Dhaka', 'কিশোরগঞ্জ'),
  d('Madaripur', 'Dhaka', 'মাদারীপুর'),
  d('Manikganj', 'Dhaka', 'মানিকগঞ্জ'),
  d('Munshiganj', 'Dhaka', 'মুন্সিগঞ্জ'),
  d('Narayanganj', 'Dhaka', 'নারায়ণগঞ্জ'),
  d('Narsingdi', 'Dhaka', 'নরসিংদী'),
  d('Rajbari', 'Dhaka', 'রাজবাড়ী'),
  d('Shariatpur', 'Dhaka', 'শরীয়তপুর'),
  d('Tangail', 'Dhaka', 'টাঙ্গাইল'),
  d('Bagerhat', 'Khulna', 'বাগেরহাট'),
  d('Chuadanga', 'Khulna', 'চুয়াডাঙ্গা'),
  d('Jashore', 'Khulna', 'Jessore', 'যশোর'),
  d('Jhenaidah', 'Khulna', 'Jhenidah', 'ঝিনাইদহ'),
  d('Khulna', 'Khulna', 'খুলনা'),
  d('Kushtia', 'Khulna', 'কুষ্টিয়া'),
  d('Magura', 'Khulna', 'মাগুরা'),
  d('Meherpur', 'Khulna', 'মেহেরপুর'),
  d('Narail', 'Khulna', 'নড়াইল'),
  d('Satkhira', 'Khulna', 'সাতক্ষীরা'),
  d('Jamalpur', 'Mymensingh', 'জামালপুর'),
  d('Mymensingh', 'Mymensingh', 'Mymensing', 'ময়মনসিংহ'),
  d('Netrokona', 'Mymensingh', 'Netrakona', 'নেত্রকোণা'),
  d('Sherpur', 'Mymensingh', 'শেরপুর'),
  d('Bogura', 'Rajshahi', 'Bogra', 'বগুড়া'),
  d('Joypurhat', 'Rajshahi', 'Jaipurhat', 'জয়পুরহাট'),
  d('Naogaon', 'Rajshahi', 'নওগাঁ'),
  d('Natore', 'Rajshahi', 'নাটোর'),
  d('Chapainawabganj', 'Rajshahi', 'Chapai Nawabganj', 'চাঁপাইনবাবগঞ্জ'),
  d('Pabna', 'Rajshahi', 'পাবনা'),
  d('Rajshahi', 'Rajshahi', 'রাজশাহী'),
  d('Sirajganj', 'Rajshahi', 'সিরাজগঞ্জ'),
  d('Dinajpur', 'Rangpur', 'দিনাজপুর'),
  d('Gaibandha', 'Rangpur', 'গাইবান্ধা'),
  d('Kurigram', 'Rangpur', 'কুড়িগ্রাম'),
  d('Lalmonirhat', 'Rangpur', 'লালমনিরহাট'),
  d('Nilphamari', 'Rangpur', 'নীলফামারী'),
  d('Panchagarh', 'Rangpur', 'পঞ্চগড়'),
  d('Rangpur', 'Rangpur', 'রংপুর'),
  d('Thakurgaon', 'Rangpur', 'ঠাকুরগাঁও'),
  d('Habiganj', 'Sylhet', 'হবিগঞ্জ'),
  d('Moulvibazar', 'Sylhet', 'Maulvibazar', 'মৌলভীবাজার'),
  d('Sunamganj', 'Sylhet', 'সুনামগঞ্জ'),
  d('Sylhet', 'Sylhet', 'Sylet', 'সিলেট'),
];

const norm = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

/** Every spelling (normalised) -> district, longest spellings first so "chapai nawabganj" is tried before shorter ones. */
const SPELLINGS = BD_DISTRICTS.flatMap((e) =>
  [e.name, ...e.aliases].map((s) => ({ key: norm(s), entry: e })),
).sort((a, b) => b.key.length - a.key.length);

/** Bangla attaches "in / of / also" to the name: ঢাকায়, চট্টগ্রামে, সিলেটের. These endings are accepted after a Bangla spelling. */
const BANGLA_ENDINGS = new Set(['', 'য়', 'য', 'ে', 'র', 'ের', 'তে', 'ও', 'ই', 'য়ও', 'য়ই']);
const isBangla = (s: string) => /[\u0980-\u09FF]/.test(s);

/** Where `key` occurs in `hay` as a whole word (a Bangla spelling may also carry one of its usual endings). */
function wordAt(hay: string, key: string): number {
  let from = 0;
  for (;;) {
    const at = hay.indexOf(` ${key}`, from);
    if (at < 0) return -1;
    const rest = hay.slice(at + 1 + key.length, hay.indexOf(' ', at + 1 + key.length));
    if (rest === '' || (isBangla(key) && BANGLA_ENDINGS.has(rest))) return at;
    from = at + 1;
  }
}

/** The districts named in `text`, in the order they appear (a district is only found as a whole word). */
export function findDistricts(text: string): DistrictEntry[] {
  const hay = ` ${norm(text)} `;
  const hits: { at: number; entry: DistrictEntry }[] = [];
  for (const { key, entry } of SPELLINGS) {
    const at = wordAt(hay, key);
    if (at >= 0 && !hits.some((h) => h.entry === entry)) hits.push({ at, entry });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.entry);
}

export function divisionOfDistrict(district: string): Division | null {
  return findDistricts(district)[0]?.division ?? null;
}
