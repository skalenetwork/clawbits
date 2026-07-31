# LobsterTalk (Teacher/Student)

This directory contains the reference Teacher (synthetic data generator) and Student (training/export) implementation described in `LobsterTalkLLMProtocol.md`.

## Generate synthetic corpus

```bash
bash ./generate_synthetic_data.sh 1000
```

This writes `./synthetic_corpus.json`.

## Train student model from `synthetic_corpus.json`

```bash
bash ./train_student.sh
```

To skip ONNX export/quantization (faster smoke run):

```bash
NO_EXPORT=1 bash ./train_student.sh
```

Or explicitly:

```bash
bash ./train_student.sh ./synthetic_corpus.json 5 128
```

Artifacts written into this folder:

- `lobstertalk_student.pt` (PyTorch weights)
- `lobstertalk_fp32.onnx` (ONNX FP32 export)
- `lobstertalk_int8.onnx` (ONNX INT8 quantized export; produced by ONNX Runtime dynamic quantization)

## Notes

- Feature extraction follows Section 2 of the spec: sender + previous sender one-hots, bounded log time delta, message length, keyword hashing (MurmurHash3 x86 32-bit, seed 0), mention flag, and padding to 64 floats.
- Output class mapping follows Section 3 (10 classes: 7 users + other + subgroup + global).

