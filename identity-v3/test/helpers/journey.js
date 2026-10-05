// TEST SUPPORT. Fake voters (registry rows + synthetic encrypted face templates) and the HTTP journey steps, driven through supertest.
import { randomInt, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import request from "supertest";
import { DESCRIPTOR_LENGTH, FACE_MODEL, TEMPLATE_VERSION } from "../../../backend-api/src/biometrics/constants.js";
import { toUnitVector } from "../../../backend-api/src/biometrics/descriptor.js";
import { sealTemplate } from "../../../backend-api/src/biometrics/templateBox.js";
import { capture, person, rounded, samplesOf } from "../../../backend-api/test/helpers/face.js";
import { fakeVoter } from "../../../privacy-v3/testing/fake-voters.js";
import { FaceTemplate } from "../../src/models/FaceTemplate.js";
import { Voter } from "../../src/models/Voter.js";

export const PASSWORD = "voter password number 1";
export const API = "/api/v3/voter";
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const newVoterId = () => "VC-" + Array.from({ length: 10 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

/** a registry voter with an enrolled (synthetic) face; `faceSeed` is the imaginary person */
export async function createVoter(config, { constituencyCode = "KA-BLR", n = 1, enrolled = true, status = "ACTIVE", password = PASSWORD } = {}) {
  const voter = await Voter.create({
    uid: randomBytes(16).toString("hex"),
    voterId: newVoterId(),
    name: `Voter Number${n}`,
    email: `voter${n}-${randomBytes(3).toString("hex")}@example.org`,
    passwordHash: await bcrypt.hash(password, 4),
    constituencyCode,
    status,
    faceEnrolled: enrolled,
  });
  if (enrolled) {
    const samples = samplesOf(person(n), 3).map(rounded).map(toUnitVector);
    await FaceTemplate.create({ voterId: voter._id, box: sealTemplate(config.secrets.faceTemplateKey, String(voter._id), samples), sampleCount: 3, dimension: DESCRIPTOR_LENGTH, algorithm: FACE_MODEL, templateVersion: TEMPLATE_VERSION, enrolledAt: new Date() });
  }
  return { doc: voter, n, id: voter.voterId, email: voter.email, password, faceSeed: n };
}

/** the voter's PUBLIC Semaphore commitment (a fake identity; the private part never leaves this test) */
export const commitmentOf = (label) => fakeVoter(label).commitment.toString();

export const cookieOf = (res, name = "vc3_voter") => (res.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${name}=`))?.split(";")[0];
export const clearedCookie = (res, name = "vc3_voter") => (res.headers["set-cookie"] ?? []).some((c) => c.startsWith(`${name}=;`) || /Expires=Thu, 01 Jan 1970/.test(c) && c.startsWith(`${name}=`));

export const login = (app, voter, password = voter.password) => request(app).post(`${API}/auth/login`).send({ identifier: voter.email, password });
export const status = (app, cookie) => request(app).get(`${API}/status`).set("Cookie", cookie ?? "");

export async function passFace(app, cookie, voter, similarity = 0.9) {
  const challenge = await request(app).post(`${API}/face/challenge`).set("Cookie", cookie).send({});
  if (challenge.status !== 200) return challenge;
  return request(app).post(`${API}/face/verify`).set("Cookie", cookie).send({ challenge: challenge.body.data.challenge, descriptor: rounded(capture(person(voter.faceSeed), similarity, 1)) });
}
export const eligibility = (app, cookie) => request(app).post(`${API}/eligibility/check`).set("Cookie", cookie ?? "").send({});
export const requestCredential = (app, cookie, body) => request(app).post(`${API}/credential`).set("Cookie", cookie ?? "").send(body);
export const pollCredential = (app, cookie) => request(app).get(`${API}/credential`).set("Cookie", cookie ?? "");

/** login -> face -> eligibility. Returns the session cookie at ELIGIBLE. */
export async function toEligible(app, voter) {
  const res = await login(app, voter);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = cookieOf(res);
  const face = await passFace(app, cookie, voter);
  if (face.status !== 200 || !face.body.data.verified) throw new Error(`face failed: ${JSON.stringify(face.body)}`);
  const el = await eligibility(app, cookie);
  if (el.status !== 200) throw new Error(`eligibility failed: ${el.status} ${JSON.stringify(el.body)}`);
  return cookie;
}
