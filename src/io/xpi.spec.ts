import fs from 'fs';
import { Readable } from 'stream';
import { EventEmitter } from 'events';

import yauzl, { Entry, ZipFile } from 'yauzl';
import realSinon, { SinonSandbox, SinonStub } from 'sinon';

import { DuplicateZipEntryError, InvalidZipFileError } from '../errors.js';
import { Xpi } from './xpi.js';
import { DEFLATE_COMPRESSION, NO_COMPRESSION } from './constants.js';
import {
  createFakeStderr,
  createFakeZipFile,
  readStringFromStream,
} from '../test-helpers.js';

describe('io/xpi', () => {
  const defaultData = {
    compressionMethod: DEFLATE_COMPRESSION,
  };

  const chromeManifestEntry = {
    ...defaultData,
    compressedSize: 138,
    uncompressedSize: 275,
    fileName: 'chrome.manifest',
  } as Entry;

  const installFileEntry = {
    ...defaultData,
    compressedSize: 416,
    uncompressedSize: 851,
    fileName: 'manifest.json',
  } as Entry;

  const dupeInstallFileEntry = {
    ...defaultData,
    compressedSize: 416,
    uncompressedSize: 851,
    fileName: 'manifest.json',
  } as Entry;

  const jsMainFileEntry = {
    ...defaultData,
    compressedSize: 41,
    uncompressedSize: 85,
    fileName: 'main.js',
  } as Entry;

  const jsSecondaryFileEntry = {
    ...defaultData,
    compressedSize: 456,
    uncompressedSize: 851,
    fileName: 'secondary.js',
  } as Entry;

  const chromeContentDir = {
    compressionMethod: NO_COMPRESSION,
    compressedSize: 0,
    uncompressedSize: 0,
    fileName: 'chrome/content/',
  };

  let fakeZipFile: ZipFile;
  let fakeZipLib: typeof yauzl;
  let openReadStreamStub: SinonStub;
  let openStub: SinonStub;
  let sinon: SinonSandbox;

  beforeAll(() => {
    sinon = realSinon.createSandbox();
  });

  beforeEach(() => {
    // This test file comes from addons-linter and it has been ported to
    // TypeScript. That being said, the whole test suite setup is weird with
    // lots of partial mocks. TS does not like that, but it was there and it
    // works...
    // TODO: rewrite this test file with better mocks.

    openReadStreamStub = sinon.stub();
    openStub = sinon.stub();

    fakeZipFile = createFakeZipFile();
    fakeZipFile.openReadStream = openReadStreamStub;

    fakeZipLib = {
      ...yauzl,
      open: openStub,
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  const createXpi = ({
    autoClose = true,
    filePath = 'foo/bar',
    stderr = createFakeStderr(),
    zipLib = fakeZipLib,
  } = {}) => {
    return new Xpi({ filePath, autoClose, stderr, zipLib });
  };

  describe('open()', () => {
    it('should resolve with zipfile', async () => {
      const myXpi = createXpi();
      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, fakeZipFile);

      const zipfile = await myXpi.open();
      expect(zipfile).toEqual(fakeZipFile);
    });

    it('should reject on error', async () => {
      const myXpi = createXpi();
      // Return the fake zip to the open callback.
      openStub.yieldsAsync(new Error('open() test error'));

      await expect(myXpi.open()).rejects.toThrow('open() test');
    });

    it('reuses the zipfile if it is still open and autoClose is disabled', async () => {
      const openZipFile = createFakeZipFile();
      openZipFile.isOpen = true;
      const myXpi = createXpi({ autoClose: false });
      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, openZipFile);

      let zip = await myXpi.open();

      expect(openStub.called).toEqual(true);
      expect(zip).toEqual(openZipFile);

      openStub.resetHistory();
      zip = await myXpi.open();

      expect(openStub.called).toEqual(false);
      expect(zip).toEqual(openZipFile);
    });

    it('does not reuse the zipfile if autoClose is disabled and the file is closed', async () => {
      const closedZipFile = createFakeZipFile();
      closedZipFile.isOpen = false;
      const myXpi = createXpi({ autoClose: false });
      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, closedZipFile);

      let zip = await myXpi.open();

      expect(openStub.called).toEqual(true);
      expect(zip).toEqual(closedZipFile);

      openStub.resetHistory();
      zip = await myXpi.open();

      expect(openStub.called).toEqual(true);
      expect(zip).toEqual(closedZipFile);
    });

    it('does not reuse the zipfile if it is still open but autoClose is enabled', async () => {
      const openZipFile = createFakeZipFile();
      openZipFile.isOpen = true;
      const myXpi = createXpi({ autoClose: true });
      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, openZipFile);

      let zip = await myXpi.open();

      expect(openStub.called).toEqual(true);
      expect(zip).toEqual(openZipFile);

      openStub.resetHistory();
      zip = await myXpi.open();

      expect(openStub.called).toEqual(true);
      expect(zip).toEqual(openZipFile);
    });
  });

  describe('getFiles()', () => {
    let closeStub: SinonStub;
    let endStub: SinonStub;
    let entryStub: SinonStub;

    beforeEach(() => {
      const onStub = sinon.stub();
      // Can only yield data to the callback once.
      closeStub = onStub.withArgs('close');
      endStub = onStub.withArgs('end');
      entryStub = onStub.withArgs('entry');

      fakeZipFile = createFakeZipFile();
      fakeZipFile.on = onStub;
    });

    it('should init class props as expected', () => {
      const filePath = 'foo/bar';
      const myXpi = createXpi({ filePath });

      expect(myXpi.path).toEqual(filePath);
      expect(typeof myXpi.files).toEqual('object');
      expect(Object.keys(myXpi.files).length).toEqual(0);
    });

    it('should return cached data when available', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      await expect(myXpi.getFiles()).resolves.toEqual(myXpi.files);
      expect(openStub.called).toBeFalsy();
    });

    it('should contain expected files', async () => {
      const myXpi = createXpi();
      const expected = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, fakeZipFile);

      // If we could use yields multiple times here we would
      // but sinon doesn't support it when the stub is only
      // invoked once (e.g. to init the event handler).
      const onEventsSubscribed = () => {
        // Directly call the 'entry' event callback as if
        // we are actually processing entries in a
        // zip.
        const entryCallback = entryStub.firstCall.args[1];
        entryCallback.call(null, chromeManifestEntry);
        entryCallback.call(null, chromeContentDir);
        entryCallback.call(null, installFileEntry);
      };

      // Call the end event callback
      endStub.yieldsAsync();

      await expect(myXpi.getFiles(onEventsSubscribed)).resolves.toEqual(
        expected,
      );
    });

    it('can be configured to exclude files', async () => {
      const myXpi = createXpi();

      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, fakeZipFile);

      const onEventsSubscribed = () => {
        // Directly call the 'entry' event callback as if
        // we are actually processing entries in a
        // zip.
        const entryCallback = entryStub.firstCall.args[1];
        entryCallback.call(null, chromeManifestEntry);
        entryCallback.call(null, chromeContentDir);
        entryCallback.call(null, installFileEntry);
      };

      // Call the end event callback
      endStub.yieldsAsync();

      myXpi.setScanFileCallback((filePath) => {
        return !/manifest\.json/.test(filePath);
      });

      const files = await myXpi.getFiles(onEventsSubscribed);
      expect(files['chrome.manifest']).toEqual(chromeManifestEntry);
      expect(files['manifest.json']).not.toBeDefined();
    });

    it('can be configured to exclude files when cached', async () => {
      const myXpi = createXpi();
      // Populate the file cache:
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      // Return the fake zip to the open callback.
      openStub.yieldsAsync(null, fakeZipFile);

      // Call the close event callback
      closeStub.yieldsAsync();

      myXpi.setScanFileCallback((filePath) => {
        return !/manifest\.json/.test(filePath);
      });

      const files = await myXpi.getFiles();
      expect(files['chrome.manifest']).toEqual(chromeManifestEntry);
      expect(files['manifest.json']).not.toBeDefined();
    });

    it('should reject on duplicate entries', async () => {
      const myXpi = createXpi();
      openStub.yieldsAsync(null, fakeZipFile);

      const onEventsSubscribed = () => {
        const entryCallback = entryStub.firstCall.args[1];
        entryCallback.call(null, installFileEntry);
        entryCallback.call(null, dupeInstallFileEntry);
      };

      const promise = myXpi.getFiles(onEventsSubscribed);
      await expect(promise).rejects.toThrow(
        'Entry "manifest.json" has already been seen',
      );
      await expect(promise).rejects.toThrow(DuplicateZipEntryError);
    });

    it('should reject on errors in open()', async () => {
      const myXpi = createXpi();

      openStub.yieldsAsync(new Error('open test'), fakeZipFile);

      await expect(myXpi.getFiles()).rejects.toThrow('open test');
    });

    it('throws an exception when a duplicate entry has been found', async () => {
      const xpi = new Xpi({
        stderr: createFakeStderr(),
        filePath: 'src/tests/fixtures/io/archive-with-duplicate-files.zip',
      });

      await expect(xpi.getFiles()).rejects.toThrow(DuplicateZipEntryError);
    });

    it('throws an exception when a duplicate entry has been found, even when autoClose is disabled', async () => {
      const xpi = new Xpi({
        autoClose: false,
        filePath: 'src/tests/fixtures/io/archive-with-duplicate-files.zip',
        stderr: createFakeStderr(),
      });

      await expect(xpi.getFiles()).rejects.toThrow(DuplicateZipEntryError);

      xpi.close();
    });

    it('throws a InvalidZipFileError exception on xpi files with invalid characters', async () => {
      const xpi = new Xpi({
        autoClose: false,
        filePath:
          'src/tests/fixtures/io/archive-with-invalid-chars-in-filenames.zip',
        stderr: createFakeStderr(),
      });

      await expect(xpi.getFiles()).rejects.toThrow(InvalidZipFileError);

      xpi.close();
    });
  });

  describe('getFile()', () => {
    it('should throw if fileStreamType is incorrect', () => {
      const myXpi = createXpi();

      expect(() => {
        // @ts-expect-error: we test the guard that prevents an invalid second argument value.
        myXpi.getFile('whatever-file', 'whatever');
      }).toThrow('Unexpected fileStreamType value "whatever"');
    });

    it('should call getFileAsString', () => {
      const myXpi = createXpi();
      const fakeFile = 'fakeFile';
      myXpi.getFileAsString = jest.fn();
      myXpi.getFile(fakeFile, 'string');

      expect(myXpi.getFileAsString).toHaveBeenCalledWith(fakeFile);
    });

    it('should call getFileAsStream', () => {
      const myXpi = createXpi();
      const fakeFile = 'fakeFile';
      myXpi.getFileAsStream = jest.fn();
      myXpi.getFile(fakeFile, 'stream');

      expect(myXpi.getFileAsStream).toHaveBeenCalledWith(fakeFile);
    });
  });

  describe('checkPath()', () => {
    it('should reject if path does not exist', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      await expect(myXpi.getFileAsStream('whatever')).rejects.toThrow(
        'Path "whatever" does not exist',
      );
    });

    it('should reject if file is too big', async () => {
      const myXpi = createXpi();
      const fakeFileMeta = {
        uncompressedSize: 1024 * 1024 * 102,
      } as Entry;

      myXpi.files = {
        'manifest.json': fakeFileMeta,
        'chrome.manifest': fakeFileMeta,
      };

      await expect(myXpi.getFileAsStream('manifest.json')).rejects.toThrow(
        'File "manifest.json" is too large',
      );
    });

    it('should reject if file is too big for getFileAsString too', async () => {
      const myXpi = createXpi();
      const fakeFileMeta = {
        uncompressedSize: 1024 * 1024 * 102,
      } as Entry;

      myXpi.files = {
        'manifest.json': fakeFileMeta,
        'chrome.manifest': fakeFileMeta,
      };

      await expect(myXpi.getFileAsString('manifest.json')).rejects.toThrow(
        'File "manifest.json" is too large',
      );
    });
  });

  // Using a file located in: src/tests/fixtures/io/dir2/dir3/file3.txt
  // The location is not relevant, the file contents are.
  describe('getChunkAsBuffer()', () => {
    it('should reject if error in openReadStream', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);
      openReadStreamStub.yieldsAsync(
        new Error('getChunkAsBuffer openReadStream test'),
      );

      const chunkLength = 123;
      await expect(
        myXpi.getChunkAsBuffer('manifest.json', chunkLength),
      ).rejects.toThrow('getChunkAsBuffer openReadStream test');
    });

    it('should resolve with a buffer', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);

      const rstream = new Readable();
      rstream.push('123\n');
      rstream.push(null);

      openReadStreamStub.yields(null, rstream);

      // Just grab the first two characters.
      const buffer = await myXpi.getChunkAsBuffer('manifest.json', 2);
      // The file contains: 123\n. This tests that we are getting just
      // the first two characters in the buffer.
      expect(buffer.toString()).toEqual('12');
    });
  });

  describe('getFileAsStream()', () => {
    it('should reject if error in openReadStream', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);
      openReadStreamStub.yieldsAsync(
        new Error('getFileAsStream openReadStream test'),
      );

      await expect(myXpi.getFileAsStream('manifest.json')).rejects.toThrow(
        'getFileAsStream openReadStream test',
      );
    });

    it('should resolve with a readable stream', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);

      const rstream = new Readable();
      rstream.push('line one\n');
      rstream.push('line two');
      rstream.push(null);

      openReadStreamStub.yields(null, rstream);

      const readStream = await myXpi.getFileAsStream('manifest.json');

      const encoding = undefined;
      const chunks = await readStringFromStream(readStream, encoding);
      const [chunk1, chunk2] = chunks.split('\n');
      expect(chunk1).toEqual('line one');
      expect(chunk2).toEqual('line two');
    });

    it('should resolve with a string', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);

      const rstream = new Readable();
      rstream.push('line one\n');
      rstream.push('line two');
      rstream.push(null);

      openReadStreamStub.yields(null, rstream);

      await expect(myXpi.getFileAsString('manifest.json')).resolves.toBe(
        'line one\nline two',
      );
    });

    it('should strip a BOM', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);

      const rstream = fs.createReadStream('src/tests/fixtures/io/dir3/foo.txt');
      openReadStreamStub.yields(null, rstream);

      const string = await myXpi.getFileAsString('manifest.json');
      expect(string.charCodeAt(0) === 0xfeff).toBeFalsy();
    });

    it('should reject if error in openReadStream from readAsString', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      openStub.yieldsAsync(null, fakeZipFile);
      openReadStreamStub.yields(
        new Error('getFileAsString openReadStream test'),
      );

      await expect(myXpi.getFileAsString('manifest.json')).rejects.toThrow(
        'getFileAsString openReadStream test',
      );
    });

    it('should reject if stream emits error', async () => {
      const fakeStreamEmitter = new EventEmitter() as Readable;

      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
      };

      myXpi.getFileAsStream = () => {
        setTimeout(() => {
          fakeStreamEmitter.emit('error', new Error('¡hola!'));
        }, 0);
        return Promise.resolve(fakeStreamEmitter);
      };

      await expect(myXpi.getFileAsString('manifest.json')).rejects.toThrow(
        '¡hola!',
      );
    });
  });

  describe('getFilesByExt()', () => {
    it('should return all JS files', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
        'main.js': jsMainFileEntry,
        'secondary.js': jsSecondaryFileEntry,
      };

      const jsFiles = await myXpi.getFilesByExt('.js');
      expect(jsFiles.length).toEqual(2);
      expect(jsFiles[0]).toEqual('main.js');
      expect(jsFiles[1]).toEqual('secondary.js');

      for (let i = 0; i < jsFiles.length; i++) {
        expect(jsFiles[i].endsWith('.js')).toBeTruthy();
      }
    });

    it('should return all CSS files', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'other.css': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
        'styles.css': jsMainFileEntry,
        'secondary.js': jsSecondaryFileEntry,
      };

      const cssFiles = await myXpi.getFilesByExt('.css');
      expect(cssFiles.length).toEqual(2);
      expect(cssFiles[0]).toEqual('other.css');
      expect(cssFiles[1]).toEqual('styles.css');

      for (let i = 0; i < cssFiles.length; i++) {
        expect(cssFiles[i].endsWith('.css')).toBeTruthy();
      }
    });

    it('should return all HTML files', async () => {
      const myXpi = createXpi();
      myXpi.files = {
        'manifest.json': installFileEntry,
        'chrome.manifest': chromeManifestEntry,
        'index.html': jsMainFileEntry,
        'second.htm': jsMainFileEntry,
        'third.html': jsMainFileEntry,
        'secondary.js': jsSecondaryFileEntry,
      };

      const htmlFiles = await myXpi.getFilesByExt('.html', '.htm');
      expect(htmlFiles.length).toEqual(3);
      expect(htmlFiles[0]).toEqual('index.html');
      expect(htmlFiles[1]).toEqual('second.htm');
      expect(htmlFiles[2]).toEqual('third.html');

      for (let i = 0; i < htmlFiles.length; i++) {
        expect(
          htmlFiles[i].endsWith('.html') || htmlFiles[i].endsWith('.htm'),
        ).toBeTruthy();
      }
    });

    it("should throw if file extension doesn't start with '.'", async () => {
      const myXpi = createXpi();

      await expect(myXpi.getFilesByExt('css')).rejects.toThrow(
        'File extension must start with',
      );
    });
  });

  describe('close()', () => {
    it('closes the zipfile when autoClose is disabled', async () => {
      const xpi = new Xpi({
        autoClose: false,
        filePath: 'src/tests/fixtures/io/simple-archive.zip',
        stderr: createFakeStderr(),
      });

      expect(xpi.zipfile).not.toBeDefined();

      // This is used to trigger a call to `open()` using the public API.
      await xpi.getFiles();

      // `zipfile` is created when `getFiles()` is called.
      expect(xpi.zipfile).toBeDefined();
      expect(xpi.zipfile && xpi.zipfile.isOpen).toEqual(true);

      xpi.close();

      expect(xpi.zipfile && xpi.zipfile.isOpen).toEqual(false);
    });

    it('does nothing when autoClose is enabled', () => {
      const xpi = new Xpi({
        autoClose: true,
        filePath: '',
        stderr: createFakeStderr(),
      });

      xpi.zipfile = createFakeZipFile();
      xpi.zipfile.close = jest.fn();

      expect(xpi.zipfile.close).not.toHaveBeenCalled();
    });
  });
});
