import type { PhoneNumberStatusRow, PhoneCheckResult } from "../types/PhoneTypes.js";

export function preprocessPhoneNumbers(
  phoneNumbersFromDB: PhoneNumberStatusRow[],
): Map<string, PhoneNumberStatusRow[]> {
  const phoneNumberMap = new Map<string, PhoneNumberStatusRow[]>();

  for (const entry of phoneNumbersFromDB) {
    let phoneNumber = entry.phone_number;

    if (phoneNumber.includes("+")) {
      phoneNumber = phoneNumber.replace(/\D/g, "");
    } else {
      phoneNumber = "55" + phoneNumber.replace(/\D/g, "").replace(/^0+/, "");
    }

    if (phoneNumber.startsWith("55")) {
      const numberWithoutNinthDigit = phoneNumber.slice(0, 4) + phoneNumber.slice(5);
      const numberWithNinthDigit = phoneNumber.slice(0, 4) + "9" + phoneNumber.slice(4);

      const addToMap = (num: string) => {
        if (!phoneNumberMap.has(num)) phoneNumberMap.set(num, []);
        phoneNumberMap.get(num)!.push(entry);
      };

      addToMap(phoneNumber);
      addToMap(numberWithoutNinthDigit);
      addToMap(numberWithNinthDigit);
    } else {
      if (!phoneNumberMap.has(phoneNumber)) phoneNumberMap.set(phoneNumber, []);
      phoneNumberMap.get(phoneNumber)!.push(entry);
    }
  }

  return phoneNumberMap;
}

export function checkPhoneNumber(
  phoneNumberMap: Map<string, PhoneNumberStatusRow[]>,
  inputPhoneNumber: string,
): PhoneCheckResult {
  const matchedEntries = phoneNumberMap.get(inputPhoneNumber) ?? [];

  if (matchedEntries.length > 0) {
    let hasJbUnder10 = false;
    let hasJbOver10 = false;
    let hasAdult = false;

    for (const entry of matchedEntries) {
      if (entry.jb_under_10) hasJbUnder10 = true;
      if (entry.jb_over_10) hasJbOver10 = true;
      if (entry.is_adult) hasAdult = true;
    }

    return {
      found: true,
      status: matchedEntries[0]!.status,
      mb: matchedEntries[0]!.registration_id,
      gender: matchedEntries[0]!.gender,
      jb_under_10: hasJbUnder10,
      jb_over_10: hasJbOver10,
      is_adult: hasAdult,
      is_legal_representative: matchedEntries[0]!.is_legal_representative,
    };
  }

  return { found: false };
}
