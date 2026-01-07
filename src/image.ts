import type { BilDataType } from "./models";

export const SUPPORTED_IMAGE_EXTENSIONS = [".bil", ".biq", ".bsq"];
export const SUPPORTED_HEADER_EXTENSIONS = [".hdr"];

export class EnviError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnviError";
  }
}

export class EnviHeaderError extends EnviError {
  constructor(message: string) {
    super(message);
    this.name = "EnviHeaderError";
  }
}

export class EnviBilError extends EnviError {
  constructor(message: string) {
    super(message);
    this.name = "EnviBilError";
  }
}

const BilDataTypes: Record<number, BilDataType> = {
  1: { name: "Uint8", byteSize: 1 },
  2: { name: "Int16", byteSize: 2 },
  3: { name: "Int32", byteSize: 4 },
  4: { name: "Float", byteSize: 4 },
  5: { name: "Double", byteSize: 8 },
  6: { name: "ComplexFloat", byteSize: 8 },
  9: { name: "ComplexDouble", byteSize: 16 },
  12: { name: "Uint16", byteSize: 2 },
  13: { name: "Uint32", byteSize: 4 },
  14: { name: "Int64", byteSize: 8 },
  15: { name: "Uint64", byteSize: 8 },
};

export class EnviImage {
  headerFile: File;
  bilFile: File;
  headerData: Record<string, string | string[]>;
  loading: Promise<void>;

  constructor(headerFile: File, bilFile: File) {
    if (
      !SUPPORTED_HEADER_EXTENSIONS.some((ext) =>
        headerFile.name.toLowerCase().endsWith(ext),
      )
    ) {
      throw new EnviHeaderError(
        `Header file must have a ${SUPPORTED_HEADER_EXTENSIONS.join("/")} extension.`,
      );
    }
    if (
      !SUPPORTED_IMAGE_EXTENSIONS.some((ext) =>
        bilFile.name.toLowerCase().endsWith(ext),
      )
    ) {
      throw new EnviBilError(
        `BIL file must have a ${SUPPORTED_IMAGE_EXTENSIONS.join("/")} extension.`,
      );
    }
    if (headerFile.name.slice(0, -4) !== bilFile.name.slice(0, -4)) {
      throw new EnviError("Header file and BIL file names do not match.");
    }

    this.headerFile = headerFile;
    this.bilFile = bilFile;
    this.headerData = {};

    this.loading = this.loadHeaderData()
      .then((data) => {
        this.headerData = data;
      })
      .catch((e) => {
        throw e;
      });
  }

  /** Loads information contained in the .hdr file. Spases in keys are replaced with underscores. */
  private async loadHeaderData(): Promise<Record<string, string | string[]>> {
    const data: Record<string, string | string[]> = {};

    try {
      const text = await this.headerFile.text();
      const lines = text.split("\n");

      if (lines.length === 0) {
        throw new EnviHeaderError("Header file is empty.");
      }

      if (lines[0] !== "ENVI") {
        throw new EnviHeaderError(
          'Invalid header file format. Should start with "ENVI".',
        );
      }

      for (let i = 1; i < lines.length; i++) {
        const line = (lines[i] as string).trim();
        const splitIndex = line.indexOf("=");
        if (splitIndex === -1) {
          continue;
        }

        const key = line
          .slice(0, splitIndex)
          .trim()
          .replace(" ", "_")
          .toLowerCase();
        let value = line.slice(splitIndex + 1).trim();

        if (value[0] === "{") {
          while (!value.endsWith("}")) {
            i++;
            if (i >= lines.length) {
              throw new EnviHeaderError(
                `Unterminated list for key "${key}" in header file.`,
              );
            }
            value += (lines[i] as string).trim();
          }
          const values = value
            .slice(1, -1)
            .split(",")
            .map((v) => v.trim());
          data[key] = values;
          continue;
        }

        data[key] = value;
      }

      if ("bands" in data) {
        const bands = parseInt(data["bands"] as string);
        if ("band_names" in data && data["band_names"].length !== bands) {
          throw new EnviHeaderError(
            "Number of band names does not match the specified number of bands.",
          );
        }
        if ("wavelength" in data && data["wavelength"].length !== bands) {
          throw new EnviHeaderError(
            "Number of wavelengths does not match the specified number of bands.",
          );
        }
      }
    } catch (e) {
      throw new EnviHeaderError(`Failed to read header file: ${e}`);
    }

    return data;
  }

  async getBilData(channels: number[]): Promise<Uint8Array> {
    await this.loading;
    const lines = parseInt(this.headerData["lines"] as string);
    const samples = parseInt(this.headerData["samples"] as string);
    const bands = parseInt(this.headerData["bands"] as string);

    if (isNaN(lines) || isNaN(samples) || isNaN(bands)) {
      throw new EnviBilError(
        "Header file is missing required dimension information (lines, samples, bands).",
      );
    }

    if (channels.some((c) => c < 0 || c >= bands)) {
      throw new EnviBilError("Requested channel index out of bounds.");
    }

    const selectedBandsCount = channels.length;
    const outputShape: [number, number, number] = [
      lines,
      samples,
      selectedBandsCount,
    ];

    const interleave = this.headerData["interleave"] as string;
    let fileStrides: [number, number, number];
    const outputStride: [number, number, number] = [
      samples * selectedBandsCount,
      1,
      samples,
    ];

    switch (interleave) {
      case "bil":
        fileStrides = [samples * bands, 1, samples];
        break;

      case "bip":
        fileStrides = [samples * bands, bands, 1];
        break;

      case "bsq":
        fileStrides = [samples, 1, lines * samples];
        break;

      default:
        throw new EnviBilError(`Unsupported interleave format: ${interleave}`);
    }

    const dataTypeCode = parseInt(this.headerData["data_type"] as string);
    const dataType = BilDataTypes[dataTypeCode];
    if (!dataType) {
      throw new EnviBilError(`Unsupported data type code: ${dataTypeCode}`);
    }
    if (this.bilFile.size % dataType.byteSize !== 0) {
      throw new EnviBilError(
        "BIL file size is not aligned with data type byte size.",
      );
    }
    if (this.bilFile.size / dataType.byteSize !== lines * samples * bands) {
      throw new EnviBilError(
        "BIL file size does not match header specifications.",
      );
    }

    const outputBuffer = new Uint8Array(
      lines * samples * selectedBandsCount * dataType.byteSize,
    );

    switch (interleave) {
      case "bil": {
        const n_bytes = samples * dataType.byteSize;

        for (let i = 0; i < outputShape[0]; i++) {
          for (let c = 0; c < selectedBandsCount; c++) {
            const channel = channels[c] as number;
            const startByte =
              (i * fileStrides[0] + channel * fileStrides[2]) *
              dataType.byteSize;
            const endByte = startByte + n_bytes;

            const slice = this.bilFile.slice(startByte, endByte);
            const buffer = new Uint8Array(await slice.arrayBuffer());

            for (let j = 0; j < outputShape[1]; j++) {
              const outputStartByte =
                (i * outputStride[0] +
                  j * outputStride[1] +
                  c * outputStride[2]) *
                dataType.byteSize;

              const sourceStart = j * fileStrides[1] * dataType.byteSize;

              const view = new Uint8Array(
                buffer.buffer,
                buffer.byteOffset + sourceStart,
                dataType.byteSize,
              );

              outputBuffer.set(view, outputStartByte);
            }
          }
        }
        break;
      }

      case "bip": {
        const n_bytes = dataType.byteSize;

        for (let i = 0; i < outputShape[0]; i++) {
          for (let c = 0; c < selectedBandsCount; c++) {
            const channel = channels[c] as number;

            for (let j = 0; j < outputShape[1]; j++) {
              const startByte =
                (i * fileStrides[0] +
                  j * fileStrides[1] +
                  channel * fileStrides[2]) *
                dataType.byteSize;
              const endByte = startByte + n_bytes;

              const slice = this.bilFile.slice(startByte, endByte);
              const buffer = new Uint8Array(await slice.arrayBuffer());

              const outputStartByte =
                (i * outputStride[0] +
                  j * outputStride[1] +
                  c * outputStride[2]) *
                dataType.byteSize;

              const view = new Uint8Array(
                buffer.buffer,
                buffer.byteOffset,
                dataType.byteSize,
              );
              outputBuffer.set(view, outputStartByte);
            }
          }
        }
        break;
      }

      case "bsq": {
        const n_bytes = lines * samples * dataType.byteSize;

        for (let c = 0; c < selectedBandsCount; c++) {
          const channel = channels[c] as number;
          const startByte = channel * fileStrides[2] * dataType.byteSize;
          const endByte = startByte + n_bytes;

          const slice = this.bilFile.slice(startByte, endByte);
          const buffer = new Uint8Array(await slice.arrayBuffer());

          for (let i = 0; i < outputShape[0]; i++) {
            for (let j = 0; j < outputShape[1]; j++) {
              const sourceStart =
                (i * fileStrides[0] + j * fileStrides[1]) * dataType.byteSize;

              const outputStartByte =
                (i * outputStride[0] +
                  j * outputStride[1] +
                  c * outputStride[2]) *
                dataType.byteSize;

              const view = new Uint8Array(
                buffer.buffer,
                buffer.byteOffset + sourceStart,
                dataType.byteSize,
              );

              outputBuffer.set(view, outputStartByte);
            }
          }
        }
        break;
      }
    }

    return outputBuffer;
  }
}
