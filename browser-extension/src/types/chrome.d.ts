/**
 * 最小 Chrome 扩展 API 环境声明，只覆盖本扩展实际使用的 tabs / scripting 子集，
 * 避免引入 @types/chrome 这一新依赖（CLAUDE.md 禁止未经批准新增依赖）。
 */
declare namespace chrome {
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
    }
    function query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Tab[]>;
    function create(createProperties: { url: string }): Promise<Tab>;
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
    }
    interface InjectionResult<Result> {
      result: Result;
    }
    function executeScript<Args extends unknown[], Result>(injection: {
      target: InjectionTarget;
      func: (...args: Args) => Result;
      args?: Args;
    }): Promise<Array<InjectionResult<Result>>>;
    function executeScript<Result = unknown>(injection: {
      target: InjectionTarget;
      files: string[];
    }): Promise<Array<InjectionResult<Result>>>;
  }

  namespace runtime {
    const lastError: { message?: string } | undefined;
    interface MessageSender {
      tab?: tabs.Tab;
      url?: string;
      id?: string;
    }
    function sendMessage<Response = unknown>(message: unknown): Promise<Response>;
    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }
}
