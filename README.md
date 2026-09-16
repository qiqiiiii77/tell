# Tell

**A medication-adherence voice agent that will not write down a "yes" the patient didn't mean.**

Built for the AssemblyAI Voice Agent Hackathon on the
[Voice Agent API](https://www.assemblyai.com/docs/voice-agents/voice-agent-api)
and [Streaming Speech-to-Text v3](https://www.assemblyai.com/docs/streaming).

---

Ask a patient whether they have been taking their tablets and most of them say
yes. Self-reported adherence overstates the real thing by a wide margin, and the
clinician on the phone knows it — which is why a good nurse does not listen to
the word "yes". They listen to the half-second before it.

Every voice agent built today throws that half-second away. The transcript says
`yes` whether it arrived instantly or after a long breath and an "uh", and the
record ends up with a fact in it that nobody actually believes.

Tell keeps it.

```
Patient   "Uh … yeah, yeah, I've been taking them."        1.9 s to start speaking

          agent → record_adherence { answer: "took_all" }

GATE      REFUSED · 34% certain
            1668 ms of dead air — "Ah." held for 1696 ms
            hesitation marker "Ah."
            transcription confidence fell to 0.61 on "been"
          → probe: ask which specific days they think they missed

Tell      "I understand. Just so I can be thorough for the clinic — do you know
           if there were any specific days you might have missed?"

Patient   "Okay, honestly — I missed Tuesday and Wednesday. I was away from home."

GATE      RECORDED · 88% certain

RECORD    metformin: missed_some (Tuesday, Wednesday)
```

That is a real run — `node tools/simulate-call.mjs`, transcript unedited.
Without the gate, the last line reads `took_all`.

---

## The one idea

The agent cannot write to the record by itself. It has to call a tool, and the
tool is gated on **how the answer sounded**:

> No adherence fact enters the clinical record unless the patient sounded
> certain — or was asked again.

A refusal is not an error. It is a specific follow-up question, chosen by
whichever signal fired, handed back to the agent in the `error` field of the
tool result. The agent reads it and asks. The patient answers properly. The
record ends up true.

This is also why the design is race-free. We decide when to return
`tool.result`, so the gate can hold the agent's turn open until the measurement
for that turn has actually landed. Nothing is guessed under time pressure.

---

## How it works

One microphone, three consumers, because no single AssemblyAI surface gives you
both a conversation and a measurement.

```
                    microphone
                        │
     ┌──────────────────┼──────────────────┐
     │                  │                  │
 24 kHz PCM16      16 kHz PCM16        Float32
     │                  │                  │
 Voice Agent API   Streaming STT v3    local DSP
 turn-taking       word timings        F0 / energy
 LLM + TTS         per-word confidence never uploaded
 tool calls        disfluencies
     │                  │                  │
     └──────────────────┼──────────────────┘
                        ▼
               vocal-certainty gate
                        │
              ┌─────────┴─────────┐
        certain enough        not certain enough
              │                     │
        write the fact        refuse + probe
```

**Why two transcriptions of the same audio?** The Voice Agent API returns
`transcript.user` as a plain string. That is everything an agent needs to answer
a question and nothing you need to judge whether someone meant it. Streaming v3
returns the same speech as words with millisecond boundaries and a per-word
confidence. One socket runs the conversation, the other measures it.

**Turn boundaries come from the agent, not the transcriber.** Streaming v3 ends
a turn on silence, and the silence in *"uh … yeah"* is precisely the thing we are
trying to measure. Letting it segment turns destroys the evidence before we can
read it — it scored our most evasive test answer at 86 % certain. See
[docs/evidence.md §3](docs/evidence.md).

---

## What the gate measures

Eight signals, combined with a noisy-OR so that one loud tell is not averaged
away by seven quiet ones. `public/js/gate.js`, ~370 lines, pure functions, no
I/O — the same file runs in the browser and under Node.

| Signal | What it catches |
|---|---|
| `onsetDelay` | how long before they started answering at all |
| `preAnswerPause` | dead air before committing — gaps **and** drawled fillers |
| `hedging` | "I think", "pretty much", "I try to" |
| `fillerLoad` | "uh", "um", weighted |
| `wordConfidence` | the transcriber's own uncertainty |
| `revision` | started one answer, switched to another |
| `arousal` | pitch and loudness moving off their own baseline |
| `brevity` | a one-word answer that took a long time to produce |

**Every signal is scored against this patient, earlier in this call.** "Slow"
only means something relative to how a person normally speaks. Turns that
nothing gated — the small talk, the consent — build the baseline. A patient who
opens every sentence at 2.2 seconds is not penalised for taking 2.2 seconds;
a patient who has been answering in 300 ms and suddenly takes 2.2 is. Both cases
are in the test suite.

Before there are enough turns for a baseline, scoring falls back to absolute
thresholds and the result is marked `baselined: false`, on the card and in the
saved record. Weak evidence is labelled as weak evidence.

### Which question comes back

The probe is chosen by which signal dominated, not from a list of ways to say
"sorry, could you repeat that?".

| Dominant signal | What the agent is told to ask |
|---|---|
| dead air / onset delay | walk through the last seven days, one day at a time |
| hedging | put a number on it — how many doses this week? |
| filler load | out of the last seven days, how many did you take it? |
| low word confidence | the audio was unstable; ask them to say it again |
| revision | which of those two is right? |
| arousal | acknowledge it's hard, say you're not judging, ask again |

### Where it stops

- **One re-ask, then it accepts.** Asking a third time is an interrogation, not
  care. The answer is recorded and flagged for a clinician instead.
- **The patient is never told any of this exists.** No mention of pauses, tone,
  scores or confidence. The system prompt forbids it explicitly.
- **The agent may not claim something was saved when it wasn't.** Also in the
  prompt, and the reason the refusal text ends with that instruction.
- **Hesitation is not deception**, and nothing in the record says it is. A low
  score means *this answer is not reliable enough to act on*, which is a claim
  about evidence, not about the person.

---

## Run it

```bash
cp .env.example .env        # add an AssemblyAI key
npm start                   # http://localhost:8000 — no dependencies, nothing resident
npm test                    # 39 tests, no network
```

Open the page, press **Start call**, and talk to it. Chrome or Edge; Firefox and
Safari work too — the audio pipeline resamples in our own code rather than
forcing a 24 kHz `AudioContext`, which is the documented shortcut and breaks echo
cancellation on Firefox and pitch on Safari.

**No microphone?** The **Gate lab** buttons on the page run the real scoring code
on four canned answers, offline, no key needed.

**No browser?** `node tools/simulate-call.mjs` synthesises a patient with macOS
`say` (including a real 900 ms hesitation), streams it to both sockets at once,
and runs the same gate. `--honest` plays a patient who genuinely took their
tablets; the gate records it at 97 % and asks nothing.

```
tools/simulate-call.mjs     the whole loop, end to end, no microphone
tools/ravdess-check.mjs     reproduces the sentiment-vs-confidence table
agent/tell.jsonc            the entire agent: prompt, voice, turn detection, tools
public/js/gate.js           the gate
public/js/stt.js            Streaming v3 client
public/js/agent.js          Voice Agent API client
docs/evidence.md            every measurement, including the one we threw out
```

---

## What we found building it

Four things that cost us a working demo each, none of them in the documentation.
All four are reproducible from this repo — [docs/evidence.md](docs/evidence.md).

1. **Sentiment analysis is prosody-blind, and word confidence isn't.** Eight
   RAVDESS readings of one sentence — neutral through terrified — all return
   `NEUTRAL` within 0.07. The same eight move minimum word confidence from
   **0.994 (calm) to 0.504 (fearful)**. The signal was in the response all along,
   just not in the field labelled "sentiment".

2. **Under stress the model writes down disfluencies nobody said.** The fearful
   reading comes back as *"Kids **uh** are talking by the door"*. There is no
   "uh" in the RAVDESS script. A hallucinated filler is still evidence — about
   the audio, if not about the words.

3. **Streaming v3 rejects any audio frame outside 50–1000 ms** with
   `error_code 3007` and closes the socket. An `AudioWorklet` naturally produces
   ~21 ms blocks, so the connection dies the moment the patient speaks. We
   buffer to 100 ms.

4. **Silence is swallowed into the preceding token.** A 900 ms hesitation inside
   *"uh … yeah"* comes back as one word, `"Ah."`, spanning **1696 ms**, with only
   128 ms of measurable gap after it. Measure gaps alone and the hesitation
   vanishes. Tell counts dead air — gaps *plus* however long a filler was held
   beyond the ~350 ms it takes to say one. On that turn: 86 % certain before,
   34 % after.

We also checked, and dropped, a claim we had been carrying that
`language_detection: true` silently disables disfluency preservation. Re-reading
the raw responses, it doesn't: both transcripts contained zero fillers and the
difference was one dropped clause. [§5](docs/evidence.md) has the diff. We pin
`language_code` anyway.

---

## Honest limits

Nothing here has clinical validation. Every number comes from RAVDESS actors and
synthesised speech; no real patient has used it. Accent, age, stammer, and
cognitive or motor conditions all shift the signals the gate reads — scoring
within a single call instead of across a population is a mitigation, not a
solution, and the one-re-ask cap exists so that a disfluent speaker pays one
extra question rather than an interrogation. A flagged answer is a prompt for a
human to look, never a conclusion.

MIT licensed.
