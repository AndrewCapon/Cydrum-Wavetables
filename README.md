# CyDrums SystemCore.bin Wavetable Tools

NOTE: Do not use, this is work in progress.

This repository contains tools for analyzing, extracting, and modifying wavetables in the CyDrums Drum Synth's `SystemCore.bin` file.

## Files

| File | Description |
|------|-------------|
| `cydrums_simple.py` | **Main tool** - No external dependencies (stdlib only) |
| `cydrums_wavetable_tools.py` | Advanced tool with numpy/scipy support |
| `WAVETABLE_FORMAT.md` | Complete file format documentation |
| `README.md` | This file |

## Quick Start

```bash
# List all 64 wavetables
python3 cydrums_simple.py SystemCore.bin --list

# Extract all as WAV files (full wavetables)
python3 cydrums_simple.py SystemCore.bin --extract-wav my_wavetables/

# Extract all 256 hardware frames per wavetable as separate WAVs
python3 cydrums_simple.py SystemCore.bin --extract-frames my_frames/

# Extract all 16 SD load chunks per wavetable as separate WAVs
python3 cydrums_simple.py SystemCore.bin --extract-chunks my_chunks/

# Generate a sine wavetable and replace index 0
python3 cydrums_simple.py SystemCore.bin --generate-sine --index 0 --output SystemCore_custom.bin

# Replace wavetable 5 with a WAV file (uses WAV file's sample rate)
python3 cydrums_simple.py SystemCore.bin --update-wav 5 --wav my_wavetable.wav --name "MyWave" --output SystemCore_custom.bin

# Replace wavetable 5 with a WAV file and override sample rate
python3 cydrums_simple.py SystemCore.bin --update-wav 5 --wav my_wavetable.wav --name "MyWave" --sample-rate 24000 --output SystemCore_custom.bin

# Using advanced tool with numpy/scipy
python3 cydrums_wavetable_tools.py SystemCore.bin --update 5 --wav my_wavetable.wav --name "MyWave" --sample-rate 44100 --output SystemCore_custom.bin
```

## Wavetable Summary

**64 wavetables** organized by category:

| Range | Category | Count | Sample Rates |
|-------|----------|-------|--------------|
| 0-13 | Sine variants | 14 | 24kHz (mostly), 44.1kHz (1) |
| 14-22 | Saw variants | 9 | 24kHz (mostly), 44.1kHz (2) |
| 23-30 | Square variants | 8 | 24kHz (mostly), 44.1kHz (1) |
| 31-37 | Triangle variants | 7 | 24kHz (mostly), 44.1kHz (2) |
| 38-39 | FM Crush | 2 | 24kHz |
| 40 | Fold Crush | 1 | 24kHz |
| 41-43 | Harmonic | 3 | 24kHz |
| 44-49 | Transform | 6 | 24kHz |
| 50-52 | Glitch | 3 | 44.1kHz |
| 53-56 | Duty cycle | 4 | 44.1kHz |
| 57-59 | Samples (Snare, Cymbal, Crush) | 3 | 384kHz |
| 60 | Sweep | 1 | 24kHz |
| 61-63 | Noise | 3 | 24kHz |

## Technical Details

- **Each wavetable**: 1 MB = 524,288 int16 samples
- **Hardware Frames**: 256 frames × 2,048 samples (addressed 0-255 directly by hardware in RAM)
- **SD Load Chunks (WTFT)**: 16 chunks × 32,768 samples = 64KB each (SD→RAM DMA transfer units)
- **Relationship**: 1 load chunk = 16 hardware frames
- **Actual acoustic cycles**: Varies per wavetable (256 for clean tones, up to 130,000+ for noise)
- **Sample data starts at**: File offset 0x1E00 (after 7,400-byte WTLS header + 272 bytes padding)
- **Wavetable spacing**: 0x100000 bytes (1 MB) apart
- **Total sample data**: 64 MB
- **Format**: Little-endian int16 (2 bytes per sample)

### Three Distinct Concepts

| Concept | Count | Size | Purpose |
|---------|-------|------|---------|
| **Hardware Frames** | 256 | 2,048 samples | Direct hardware addressing (0-255 in RAM) |
| **SD Load Chunks (WTFT)** | 16 | 32,768 samples | SD→RAM DMA transfer units (64KB each) |
| **Acoustic Waveform Cycles** | Varies | Varies | Actual waveform periods in audio |

## Creating Custom Wavetables

### From WAV File

```bash
# WAV must be: Mono, 16-bit
# Will be resized to 524,288 samples (16 load chunks × 32,768 = 256 hardware frames × 2,048)
# Uses WAV file's sample rate by default
python3 cydrums_simple.py SystemCore.bin --update-wav 10 --wav my_sound.wav --name "CustomSine" --output SystemCore_new.bin

# Override sample rate (must be 24000, 44100, or 384000)
python3 cydrums_simple.py SystemCore.bin --update-wav 10 --wav my_sound.wav --name "CustomSine" --sample-rate 24000 --output SystemCore_new.bin
```

### Programmatically (Python)

```python
from cydrums_simple import SimpleWavetableExtractor, generate_sine_wavetable

extractor = SimpleWavetableExtractor("SystemCore.bin")

# Option 1: Use built-in generator
samples = generate_sine_wavetable(sample_rate=44100, load_chunks=16, chunk_size=65536)

# Option 2: Load from WAV
samples, sr = extractor.load_wav("my_wavetable.wav")
# Resize to exactly 524,288 samples
expected = 524288
if len(samples) < expected:
    samples = samples + [0] * (expected - len(samples))
elif len(samples) > expected:
    samples = samples[:expected]

# Update and save
extractor.update_wavetable(0, samples, new_name="MyCustom", new_sr=44100)
extractor.save("SystemCore_custom.bin")

# Access individual frames/chunks
frames = extractor.get_frames(0)        # All 256 hardware frames
frame_5 = extractor.get_frame(0, 5)     # Single hardware frame (0-255)
chunks = extractor.get_load_chunks(0)   # All 16 SD load chunks
chunk_3 = extractor.get_load_chunk(0, 3)  # Single load chunk (0-15)
```

### Raw Sample Generation

```python
import math

# Generate 16 load chunks of 32768 samples each = 524288 total
sample_rate = 44100
samples_per_chunk = 32768
load_chunks = 16
total = samples_per_chunk * load_chunks

samples = [0] * total
f0 = sample_rate / samples_per_chunk

for c in range(load_chunks):
    for i in range(samples_per_chunk):
        t = i / sample_rate
        # Add harmonics that evolve across load chunks
        for h in range(1, 8):
            amp = (1.0 / h) * (1.0 - c / load_chunks * 0.5)
            samples[c * samples_per_chunk + i] += amp * math.sin(2 * math.pi * h * f0 * t)

# Normalize to int16
max_val = max(abs(s) for s in samples)
samples = [int(s * 32767 / max_val) for s in samples]
```

## File Format (Brief)

```
SystemCore.bin
├── WTLS Header (0x00000000 - 0x00001CF0)
│   ├── 64 × WTNM (names)
│   ├── 64 × WTFT (format: sample rate, load_chunks, chunk_size, ram_size)
│   └── 64 × WTPL (offsets into sample data)
├── Sample Data (0x00001E00 - 0x04001E00)
│   ├── Wavetable 0: 0x00001E00 - 0x00101E00 (1 MB)
│   ├── Wavetable 1: 0x00101E00 - 0x00201E00 (1 MB)
│   └── ... (64 total)
└── Padding (0xFFFFFFFF to EOF)
```

See `WAVETABLE_FORMAT.md` for complete documentation.

## Requirements

- Python 3.8+
- `cydrums_simple.py`: Standard library only
- `cydrums_wavetable_tools.py`: `numpy`, `scipy` (`pip install numpy scipy --break-system-packages`)

## License

Educational/reverse engineering purposes. Use responsibly.

## Use of AI

Parts of this project, code and documentation, may be written with the help of AI tools, mainly Claude by Anthropic with nvidia nemotron-3-ultra-550b-a55b. AI tools are not credited as authors in the commit history.