import { findLeaks } from "../../identity-v3/test/helpers/leak.js";

export { findLeaks };
/** every string value of a storage, joined: what an attacker who can read the browser's storage after the vote would see */
export const storageText = (storage) => JSON.stringify(storage.dump());
