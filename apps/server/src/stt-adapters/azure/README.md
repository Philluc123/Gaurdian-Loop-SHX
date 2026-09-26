# stt-adapters/azure

Implements the `SttAdapter` interface from [`../README.md`](../README.md) for Azure
Speech. Normalize Azure-specific response shapes into `TranscriptEvent` here —
nothing Azure-specific should leak past this folder.
