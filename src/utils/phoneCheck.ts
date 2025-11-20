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
    let hasJbOver12 = false;
    let hasAdult = false;
    let hasAdultFemale = false;
    let isLegalRepresentative = false;
    let representsJbOver12 = false;
    let representsMinor = false; 
    let childPhoneMatchesLegalRep = true; 

    for (const entry of matchedEntries) {
      if (entry.jb_under_10) hasJbUnder10 = true;
      if (entry.jb_over_10) hasJbOver10 = true;
      if (entry.jb_over_12) hasJbOver12 = true;
      if (entry.is_adult) hasAdult = true;
      if (entry.gender === "Feminino" && entry.is_adult) hasAdultFemale = true;
      if (!entry.child_phone_matches_legal_rep) childPhoneMatchesLegalRep = false;
      if (entry.is_legal_representative) {
        isLegalRepresentative = true;
        if (entry.jb_over_12) representsJbOver12 = true;
        if (entry.jb_under_10 || entry.jb_over_10) representsMinor = true; 
      }
    }

    return {
      found: true,
      status: matchedEntries[0]!.status,
      mb: matchedEntries[0]!.registration_id,
      gender: matchedEntries[0]!.gender,
      jb_under_10: hasJbUnder10,
      jb_over_10: hasJbOver10,
      jb_over_12: hasJbOver12,
      is_adult: hasAdult,
      is_legal_representative: isLegalRepresentative,
      represents_jb_over_12: representsJbOver12,
      represents_minor: representsMinor,
      has_adult_female: hasAdultFemale,
      child_phone_matches_legal_rep: childPhoneMatchesLegalRep,
    };
  }

  return { found: false };
}
