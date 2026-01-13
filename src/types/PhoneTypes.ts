export type Gender = "Masculino" | "Feminino";

export interface PhoneNumberStatusRow {
  phone_number: string;
  registration_id: number;
  gender: Gender;
  status: "Active" | "Inactive";
  jb_under_13: boolean;
  jb_13_to_17: boolean;
  is_adult: boolean;
  is_legal_representative: boolean;
  child_phone_matches_legal_rep: boolean;
  has_accepted_terms: boolean;
}

export interface PhoneCheckResult {
  found: boolean;
  status?: "Active" | "Inactive";
  mb?: number;
  gender?: Gender;
  jb_under_13?: boolean;
  jb_13_to_17?: boolean;
  is_adult?: boolean;
  is_legal_representative?: boolean;
  represents_jb_13_to_17?: boolean;
  has_adult_female?: boolean;
  represents_minor?: boolean;
  child_phone_matches_legal_rep?: boolean;
  has_accepted_terms?: boolean;
}
