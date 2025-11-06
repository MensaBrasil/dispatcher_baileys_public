
export type Gender = "Masculino" | "Feminino";

export interface PhoneNumberStatusRow {
  phone_number: string;
  registration_id: number;
  gender: Gender;
  status: "Active" | "Inactive";
  jb_under_10: boolean;
  jb_over_10: boolean;
  jb_over_12: boolean;
  is_adult: boolean;
  is_legal_representative: boolean;
}

export interface PhoneCheckResult {
  found: boolean;
  status?: "Active" | "Inactive";
  mb?: number;
  gender?: Gender;
  jb_under_10?: boolean;
  jb_over_10?: boolean;
  jb_over_12?: boolean;
  is_adult?: boolean;
  is_legal_representative?: boolean;
  represents_jb_over_12?: boolean;
  has_adult_female?: boolean;
  represents_minor?: boolean;
}
