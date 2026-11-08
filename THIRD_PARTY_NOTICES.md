# Third-party notices

Score Studio does not redistribute any model weights or third-party binaries. Everything below is downloaded at
install, build or run time and keeps its own license.

## Models

- **DuET**: https://github.com/wei-zeng98/DuET. The code is MIT. The weights (https://huggingface.co/Wayne42/DuET) are
  **CC BY-NC 4.0**: attribution required, no commercial use. `backend/app/engrave/` is a modified fork of DuET's
  readable engraver and stays under DuET's MIT License (`backend/app/engrave/LICENSE-DuET`).
- **Transkun v2**: https://github.com/Yujia-Yan/Transkun. MIT, Copyright (c) 2021 Yujia Yan. The v2 checkpoint is
  distributed inside the `transkun` pip package.
  Yujia Yan and Zhiyao Duan, "Scoring Time Intervals Using Non-Hierarchical Transformer for Automatic Piano
  Transcription", ISMIR 2024.

## Python packages (`backend/requirements.txt`)

| Package | License |
|---|---|
| torch, torchaudio | BSD-3-Clause |
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| python-multipart | Apache-2.0 |
| httpx | BSD-3-Clause |
| verovio | LGPL-3.0-or-later |
| pretty-midi, mir-eval, pydub | MIT |
| scipy, psutil | BSD-3-Clause |
| soxr | LGPL-2.1-or-later |
| matplotlib | Matplotlib License (PSF-based) |
| tqdm | MPL-2.0 / MIT |
| torch-optimizer | Apache-2.0 |
| moduleconf | see the package |
| huggingface-hub, safetensors | Apache-2.0 |
| numpy, pandas, mido | BSD-3-Clause / BSD-3-Clause / MIT |

## Web packages (`web/package.json`)

| Package | License |
|---|---|
| react, react-dom | MIT |
| verovio (WASM) | LGPL-3.0-or-later |
| tone, @tonejs/midi | MIT |
| lucide-react | ISC |
| vite, @vitejs/plugin-react, typescript, @playwright/test | MIT / MIT / Apache-2.0 / Apache-2.0 |

## Assets

- **Rubik** font (`web/public/fonts/`): SIL Open Font License 1.1, Copyright 2015 The Rubik Project Authors
  (https://github.com/googlefonts/rubik). See `web/public/fonts/OFL.txt`.
- **Salamander Grand Piano** samples, loaded at runtime from https://tonejs.github.io/audio/salamander/:
  CC BY 3.0, by Alexander Holm.
- **Demo score** (`web/public/fixtures/score.musicxml`): a Score Studio transcription of Chopin's Étude Op. 25
  No. 11, a public-domain composition.

## Tools

- **FFmpeg** (installed separately, or from Debian in the Docker image): LGPL/GPL depending on the build.
- **YourMT3+** (optional, multi-instrument mode): https://github.com/mimbres/YourMT3 and
  https://huggingface.co/mimbres/YourMT3 (code: Hugging Face space `mimbres/YourMT3`). Apache-2.0. Downloaded by
  `backend/mt3/download.py`; not stored in this repo.
