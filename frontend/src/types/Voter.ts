export interface Voter {
  _id: string;
  VoterId: string;
  name: string;
  email: string;
  constituency: string;
  contact?: string;
  Address?: string;
  token?: string;
}
