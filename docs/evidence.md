# Evidence

Everything the gate assumes, and the measurement behind it. Where a number is
weak, it says so.

---

## 1. AssemblyAI's sentiment analysis does not hear prosody

The RAVDESS corpus has the same actor say the same sentence — *"Kids are talking
by the door"* — in eight emotional states. We transcribed all eight with
Universal-3.5-Pro and sentiment analysis enabled.

| Emotion | Official sentiment | Min word confidence | F0 mean (Hz) | RMS | Transcript |
|---|---|---|---|---|---|
| neutral | NEUTRAL (0.564) | 0.996 | — | 0.002 | Kids are talking by the door. |
| calm | NEUTRAL (0.564) | 0.994 | — | 0.001 | Kids are talking by the door. |
| happy | NEUTRAL (0.564) | 0.614 | 224.6 | 0.006 | Kids are talking by the door. **Hm** |
| sad | NEUTRAL (0.564) | 0.990 | — | 0.003 | Kids are talking by the door. |
| angry | NEUTRAL (0.594) | 0.905 | 320.6 | 0.051 | Kids are talking by the door! |
| **fearful** | NEUTRAL (0.633) | **0.504** | 225.6 | 0.016 | Kids **uh** are talking by the door. |
| disgust | NEUTRAL (0.564) | 0.821 | 252.8 | 0.011 | Kids are talking by the door. |
| surprised | NEUTRAL (0.564) | 0.948 | 186.2 | 0.007 | Kids are talking by the door. |

Three things come out of this table.

**The sentiment field is a text classifier.** Eight readings that a human tells
apart instantly all return NEUTRAL, within 0.07 of each other. That is correct
behaviour — the words really are neutral — and it is exactly why a product that
needs to know whether someone meant it cannot use that field.

**Word confidence moves with arousal.** Fear drops the weakest word to 0.504
while calm holds 0.994. The transcriber's own uncertainty is a usable proxy for
the speaker's state, and it is free: it is already in the response.

**The model inserts disfluencies that the speaker never said.** RAVDESS actors
read a fixed script with no "uh" in it. Under fear the transcript gains one
(*"Kids uh are talking"*); under happiness it gains a trailing *"Hm"*. The model
is not hearing a filler, it is failing to resolve a stressed vowel and writing
down the nearest thing. A hallucinated filler is a signal about the audio even
though it is wrong about the words.

**Sample size: one actor, one sentence, eight renditions (n = 8).** This is
enough to show the sentiment field is prosody-blind and to motivate using word
confidence. It is not enough to fit a threshold on, and we did not fit one on it
— the gate's cutoffs come from the scale of the effects, not from this table.

Raw data: [`samples/ravdess/ravdess_results.json`](../samples/ravdess/), audio in
the same folder. Re-run with `node tools/ravdess-check.mjs`.

---

## 2. Streaming v3 rejects audio frames outside 50–1000 ms

Not in the docs. An `AudioWorklet` hands you 128 frames at a time; batching to
512 samples at 24 kHz gives ~21 ms blocks, which is the natural thing to send.
Do that and the socket dies mid-call:

```
{"type":"Error","error_code":3007,
 "error":"Input Duration Error: Input Duration Violation: 20.0 ms.
          Expected between 50 and 1000 ms"}
→ close 3007
```

The close happens on the first frame, so a live call ends the moment the patient
opens their mouth. `public/js/stt.js` accumulates to 100 ms frames before
sending.

---

## 3. The transcriber uses the pause we need to measure as a delimiter

Streaming v3 ends a turn on silence. The hesitation in *"uh … yeah, I've been
taking them"* is silence. So v3 splits one answer into three turns:

```
[stt] 1 words   "Ah."
[stt] 2 words   "Yeah, yeah."
[stt] 3 words   "been taking them."
```

Score the last fragment and you are scoring a confident three-word statement.
The pause has become a boundary instead of evidence, and the gate reads **86 %
certain** on the most evasive answer in the call.

This is why Tell does not let two components do turn detection. The Voice Agent
API owns turn-taking, because it owns the conversation; Streaming v3 is an
instrument, and its words are stitched back together across its own turn
boundaries using the agent's `input.speech.started` / `input.speech.stopped`.

---

## 4. Silence gets swallowed into the token that precedes it

Even after stitching, the hesitation nearly disappeared. The word dump explains
why:

```
Ah.(0–1696ms, conf 0.944)  Yeah,(1824–2639)  yeah.(2671–3486)  been(3616–3948, conf 0.608)
```

A one-syllable filler with a duration of **1.7 seconds**. The 900 ms of silence
is inside the token, not between tokens — the measurable inter-word gap is only
128 ms.

Measuring gaps alone therefore misses most real hesitation. Tell counts *dead
air*: inter-word gaps **plus** however long a filler was held beyond the ~350 ms
it takes to say one. On the same turn that is 1668 ms, and the gate reads **34 %
certain** instead of 86 %.

A drawled "uhhhh" and a silent pause are the same behaviour. Only one of them
shows up as a gap.

---

## 5. What we checked and did not use

An earlier version of this project claimed that setting `language_detection:
true` silently disables disfluency preservation. Re-reading the raw responses
before publishing, that is not what the data shows:

| Run | `language_detection` | Words | Recognised fillers |
|---|---|---|---|
| A | `true` | 401 | 0 |
| B | `false`, `language_code: en_us` | 412 | 0 |

Neither transcript contains a single `uh` / `um`. The 11-word difference is one
dropped clause — *"Bonus, but an MRI confirmed he has a torn rotator cuff."* —
present in B and missing from A, not stripped disfluencies.

What remains true is narrower and less exciting: on this file, a
language-detection pass and a pinned-language pass of the same audio produced
different transcripts, and the detection pass lost a clause. That is worth
knowing, and it is why Tell pins `language_code: "en"`. It is not a hidden
feature flag, and we are not claiming it is.

---

## Limitations we are not going to paper over

- **Hesitation is not deception.** A pause means the answer is unreliable, not
  that it is a lie. Tell's response to a refused write is a follow-up question,
  never an accusation, and never a note in the record calling the patient
  evasive.
- **The baseline needs a warm-up.** The first two turns are scored against
  absolute thresholds and marked `baselined: false`. Anything scored that way is
  weaker evidence, and the UI says so on the card.
- **Accent, age, disfluent speech, and cognitive or motor conditions all move
  the baseline.** Scoring within a call rather than across a population is the
  mitigation, and it is a partial one. A patient with a stammer will hit the gate
  more often; the cap of one re-ask exists so that this costs them one extra
  question, not an interrogation.
- **We have not tested this on real patients.** Every number here comes from
  RAVDESS actors and synthesised speech. Nothing in this repo has clinical
  validation, and the product is designed so a human clinician reads every
  flagged answer.
- **n is small everywhere.** Eight RAVDESS renditions, one scripted call.
