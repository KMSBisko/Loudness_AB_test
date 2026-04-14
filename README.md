# Loudness A/B Reliability Test

A small browser app to test whether a listener can reliably detect a loudness difference between two versions of the same track.

## Features

- Load any local audio file.
- Set precise dB difference (e.g., 0.1 or 0.01).
- Choose number of trials.
- Listen to A/B with playback and scrub control.
- On each trial, choose whether A or B is louder.
- End-of-test stats:
  - Correct count and accuracy
  - One-sided binomial p-value vs chance (50%)
  - 95% Wilson confidence interval for true accuracy

## How to run

1. Open `index.html` in a modern browser.
2. Select an audio file.
3. Enter dB difference and number of trials.
4. Start test and complete all trials.

## Notes

- This app uses the Web Audio API and runs entirely locally.
- A and B are randomly assigned per trial so the louder version is hidden from the participant.
