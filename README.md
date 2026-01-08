# ENVI image reader

_Process images from the ENVI geospatial analysis software._


# Usage

```javascript
import { EnviImage } from 'envi-image-reader/image';

// headerFile and bilFile must be File objects
const image = new EnviImage(headerFile, bilFile);
await image.loadHeaderData();

const channels = [0, 1, 2]; // specify the channels to read
const data = await image.getBilData(channels);  // Uint8Array
```


# Contributing

## Publication to npm

To publish a new version of the package to npm, create a git tag in the format `vX.Y.Z`. Leave the version in `package.json` unchanged.


# Contributors

- [**EPFL ENAC-IT4R**](enac-it4r.epfl.ch): [Son Pham-Ba](https://github.com/sphamba)
- [**EPFL ESO**](https://www.epfl.ch/labs/eso/): [Laurent Jospin](https://github.com/french-paragon), [Jesse Lahaye](https://people.epfl.ch/jesse.lahaye), and [Jan Skaloud](https://people.epfl.ch/jan.skaloud)
