Score Studio — portable Windows app
===================================

Start: double-click ScoreStudio.exe. Keep the folder together (ScoreStudio.exe, app, runtime, models, data).
Nothing is installed; delete the folder to remove it. The first start takes up to a minute.

First start: the app asks to download its model files (about 0.4 GB for piano transcription, plus about 0.5 GB
for multiple instruments) from Hugging Face, with one click. They are saved in the "models" folder.
Settings > Storage shows what is installed and how much space projects, models and the app use.

Requirements: Windows 10/11 64-bit with the Microsoft Edge WebView2 runtime (built into Windows 11).
An NVIDIA GPU (CUDA) is used automatically when present; otherwise transcription runs on the CPU.

Your projects and settings are stored in the "data" folder next to ScoreStudio.exe.
Logs: data\logs\desktop.log

Multi-instrument transcription (beta) uses YourMT3+; piano transcription uses Transkun and DuET.
DuET's model weights are CC BY-NC 4.0: personal and non-commercial use only. See THIRD_PARTY_NOTICES.md.

Author: Tommy Duan — GitHub tommy-duan-github, Discord dafisherman.
