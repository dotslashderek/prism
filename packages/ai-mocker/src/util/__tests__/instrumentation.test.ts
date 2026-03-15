import { timeStage, PipelineTimer } from '../instrumentation';

describe('instrumentation', () => {
  describe('timeStage', () => {
    it('returns result and positive durationMs on success', async () => {
      const mockLogger = { info: jest.fn() };
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return 'success';
      };

      const { result, durationMs } = await timeStage('test_stage', fn, mockLogger);

      expect(result).toBe('success');
      expect(durationMs).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'test_stage',
          durationMs: expect.any(Number),
        }),
        expect.stringContaining('test_stage')
      );
    });

    it('propagates error and logs duration on failure', async () => {
      const mockLogger = { info: jest.fn() };
      const fn = async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        throw new Error('test error');
      };

      await expect(timeStage('fail_stage', fn, mockLogger)).rejects.toThrow('test error');

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'fail_stage',
          durationMs: expect.any(Number),
          error: true,
        }),
        expect.stringContaining('fail_stage')
      );
    });
  });

  describe('PipelineTimer', () => {
    it('accumulates timings and computes total summary', () => {
      const timer = new PipelineTimer();
      timer.record('embedding', 150);
      timer.record('context', 10);
      timer.record('llm', 1200);
      
      const sum = timer.summary();
      expect(sum).toEqual({
        embedding: 150,
        context: 10,
        llm: 1200,
        total: 1360,
      });

      timer.record('context', 5);
      expect(timer.summary()).toEqual({
        embedding: 150,
        context: 15,
        llm: 1200,
        total: 1365,
      });
    });
  });
});
