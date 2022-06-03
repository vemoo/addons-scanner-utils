import { IOBase } from './base.js';
import { FLAGGED_FILE_MAGIC_NUMBERS_LENGTH } from './constants.js';
import { createFakeStderr } from '../test-helpers.js';

describe('io/base', () => {
  const createIOBase = ({
    filePath = 'foo/bar/',
    stderr = createFakeStderr(),
  } = {}) => {
    return new IOBase({ filePath, stderr });
  };

  describe('IOBase()', () => {
    it('should init class props as expected', () => {
      const filePath = 'foo/not-bar';
      const io = createIOBase({ filePath });

      expect(io.path).toEqual(filePath);
      expect(io.entries.length).toEqual(0);
      expect(Object.keys(io.files).length).toEqual(0);
      expect(typeof io.files).toEqual('object');
      expect(io.maxSizeBytes).toEqual(104857600);
    });

    it('should reject calling getFiles()', async () => {
      const io = createIOBase();

      await expect(io.getFiles()).rejects.toThrow(
        'getFiles is not implemented',
      );
    });

    it('should reject calling getFileAsString()', async () => {
      const io = createIOBase();

      await expect(io.getFileAsString('file')).rejects.toThrow(
        'getFileAsString is not implemented',
      );
    });

    it('should reject calling getFileAsStream()', async () => {
      const io = createIOBase();

      await expect(io.getFileAsStream('file')).rejects.toThrow(
        'getFileAsStream is not implemented',
      );
    });

    it('should reject calling getChunkAsBuffer()', async () => {
      const io = createIOBase();
      const length = 123;

      await expect(io.getChunkAsBuffer('file', length)).rejects.toThrow(
        'getChunkAsBuffer is not implemented',
      );
    });

    it('should call getFileAsStream method via getFile()', () => {
      const io = createIOBase();
      io.getFileAsStream = jest.fn();
      io.getFile('get-a-stream', 'stream');
      expect(io.getFileAsStream).toHaveBeenCalledWith('get-a-stream');
    });

    it('should call getFileAsString method via getFile()', () => {
      const io = createIOBase();
      io.getFileAsString = jest.fn();
      io.getFile('get-a-string', 'string');
      expect(io.getFileAsString).toHaveBeenCalledWith('get-a-string');
    });

    it('should call getChunkAsBuffer method via getFile()', () => {
      const io = createIOBase();
      io.getChunkAsBuffer = jest.fn();
      io.getFile('get-a-chunk-as-buffer', 'chunk');
      expect(io.getChunkAsBuffer).toHaveBeenCalledWith(
        'get-a-chunk-as-buffer',
        FLAGGED_FILE_MAGIC_NUMBERS_LENGTH,
      );
    });

    it('should scan all files by default', () => {
      const io = createIOBase();
      expect(io.shouldScanFile('manifest.json', false)).toBeTruthy();
    });

    it('should allow configuration of which files can be scanned', () => {
      const io = createIOBase();
      expect(io.shouldScanFile('manifest.json', false)).toBeTruthy();
    });

    it('should ignore undefined scan file callbacks', () => {
      const io = createIOBase();
      // @ts-expect-error: we ignore the TS error below because we want to test
      // the guard that prevents undefined callbacks.
      io.setScanFileCallback(undefined);
      expect(io.shouldScanFile('manifest.json', false)).toBeTruthy();
    });

    it('should ignore a non-function scan file callback', () => {
      const io = createIOBase();
      // @ts-expect-error: we ignore the TS error below because we want to test
      // the guard that prevents callbacks that are not functions.
      io.setScanFileCallback(42); // this is not a function
      expect(io.shouldScanFile('manifest.json', false)).toBeTruthy();
    });
  });
});
