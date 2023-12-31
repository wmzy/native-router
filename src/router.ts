import {createPath, History, parsePath} from 'history';
import {match as createMatcher} from 'path-to-regexp';
import type {
  Location,
  Matched,
  Options,
  BaseRoute,
  RouterInstance,
  ResolveView,
  HistoryState
} from './types';
import {createCurrentGuard, noop, reject} from './util';
import {NotFoundError} from './errors';

/**
 * Create a router instance.
 * @group Methods
 * @category Router
 * @param routes routes config
 * @param history {@link https://www.npmjs.com/package/history history} instance
 * @param resolveView a callback to resolve view. see {@link defaultResolveView}
 * @param options options
 * @returns a router instance
 */
export function create<R extends BaseRoute = BaseRoute, V = any>(
  routes: R | R[],
  history: History,
  resolveView: ResolveView<R, V>,
  options?: Options<V>
): RouterInstance<R, V> {
  type InstanceHistory = RouterInstance<any>['history'];

  const [currentGuard, cancelAll] = createCurrentGuard();
  const {index, locationStack} = getHistoryState({
    history: history as InstanceHistory
  });
  const viewStack = new Array(locationStack.length).fill(null);

  if (options?.currentView) {
    viewStack[index] = options.currentView;
  }

  return {
    routes: Array.isArray(routes) ? routes : [routes],
    resolveView,

    history: history as InstanceHistory,
    locationStack,
    viewStack,
    currentGuard,
    cancelAll,

    errorHandler: reject,
    ...options,
    baseUrl: options?.baseUrl || ''
  };
}

export function setOptions<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  options: Omit<Options<V>, 'currentView'>
) {
  return Object.assign(router, options);
}

export function getLocation({history}: Pick<RouterInstance<any>, 'history'>) {
  const state = (history.location.state || {}) as Partial<HistoryState>;
  return {...history.location, state: state.state};
}

function getHistoryState(router: Pick<RouterInstance<any>, 'history'>) {
  const {location} = router.history;
  const state = (location.state || {}) as Partial<HistoryState>;
  return {
    index: state.index || 0,
    locationStack: state.locationStack || [getLocation(router)]
  };
}

export function getCurrentView<R extends BaseRoute = BaseRoute>(
  router: RouterInstance<R>
) {
  return router.viewStack[getHistoryState(router).index];
}

/**
 * Match a path.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param pathname the pathname
 * @returns the matched result
 */
export function match<R extends BaseRoute = BaseRoute>(
  router: RouterInstance<R>,
  pathname: string
) {
  function matchRoutes(
    routes: R[],
    baseUrl: string,
    // eslint-disable-next-line @typescript-eslint/no-shadow
    pathname: string
  ): Matched<R>[] | undefined {
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const end = !route.children;
      const matched = route.path
        ? createMatcher<Record<string, string>>(route.path, {
            strict: true,
            sensitive: true,
            decode:
              typeof decodeURIComponent === 'function'
                ? decodeURIComponent
                : undefined,
            end
          })(pathname)
        : {
            path: '',
            index: 0,
            params: {}
          };

      if (matched) {
        const result = {route, ...matched};
        if (end) return [result];
        const children = matchRoutes(
          route.children!,
          `${baseUrl}${route.path || ''}`,
          pathname.slice(matched.path.length)
        );
        if (children) return [result, ...children];
        return undefined;
      }
    }
    return undefined;
  }

  return matchRoutes(
    router.routes,
    router.baseUrl,
    pathname.slice(router.baseUrl.length)
  );
}

/**
 * Path to Location.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param to path string
 * @param state the state of location
 * @returns location
 */
export function toLocation<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  to: string,
  state?: any
): Location {
  const {baseUrl} = router;
  return {
    pathname: '',
    search: '',
    hash: '',
    ...parsePath(baseUrl + to),
    state
  };
}

/**
 * Resolve a location.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param location history instance
 * @returns resolve task(a promise)
 */
export function resolve<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  location: Location
) {
  const matched = match<R>(router, location.pathname);
  const {resolveView, errorHandler} = router;
  return (
    matched
      ? resolveView(matched, {router, location})
      : Promise.reject(new NotFoundError(location.pathname))
  ).catch(errorHandler);
}

/**
 * Resolve a path.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param to the path
 * @param state state of the path location
 * @returns resolve task(a promise)
 */
export function resolveTo<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  to: string,
  state?: any
) {
  const location = toLocation(router, to, state);
  return resolve(router, location);
}

/**
 * Commit the resolve task and push history.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param resolvePromise resolve task(a promise)
 * @param location the location to resolved
 */
export function commit<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  resolvePromise: Promise<V>,
  location: Location
): Promise<void> {
  const {history} = router;
  const nextIndex = getHistoryState(router).index + 1;
  return commitBase(router, resolvePromise, location, (resolvedView) => {
    router.locationStack = [
      ...router.locationStack.slice(0, nextIndex),
      location
    ];
    router.viewStack = [...router.viewStack.slice(0, nextIndex), resolvedView];
    history.push(location, {
      index: nextIndex,
      locationStack: router.locationStack,
      state: location.state
    });
  });
}

/**
 * Commit the resolve task and replace history.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param resolvePromise resolve task(a promise)
 * @param location the location to resolved
 */
export function commitReplace<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  resolvePromise: Promise<V>,
  location: Location
): Promise<void> {
  const {history} = router;
  const {index} = getHistoryState(router);
  return commitBase(router, resolvePromise, location, (resolvedView) => {
    router.locationStack[index] = location;
    router.viewStack[index] = resolvedView;
    history.replace(location, {
      index,
      locationStack: router.locationStack,
      state: location.state
    });
  });
}

function commitBase<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  resolvePromise: Promise<V>,
  location: Location,
  onResolved: (resolvedView: V) => void
): Promise<void> {
  const {currentGuard, onLoadingChange = noop} = router;
  if (router.resolving) {
    // Cancel current resolve
    onLoadingChange();
  }
  router.resolving = location;
  onLoadingChange('pending');
  return (
    currentGuard(resolvePromise)
      .then(onResolved)
      // eslint-disable-next-line no-void
      .then(() => void onLoadingChange('resolved'))
      .catch((e) => {
        onLoadingChange('rejected');
        throw e;
      })
  );
}

/**
 * Navigate to a new path.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param to path string
 * @param state location state
 */
export function navigate<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  to: string,
  state?: any
): Promise<void> {
  const location = toLocation(router, to, state);
  const viewPromise = resolve(router, location);
  return commit(router, viewPromise, location);
}

/**
 * Refresh the page.
 * @group Methods
 * @category Router
 * @param router router instance
 */
export function refresh<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>
) {
  const location = getLocation(router);
  const viewPromise = resolve(router, location);
  return commitReplace(router, viewPromise, location);
}

/**
 * Navigate in history stack.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param delta history stack index
 */
export function go<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  delta: number
) {
  router.history.go(delta);
}

/**
 * Forward in history stack.
 * @group Methods
 * @category Router
 * @param router router instance
 */
export function forward<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>
) {
  router.history.forward();
}

/**
 * Back in history stack.
 * @group Methods
 * @category Router
 * @param router router instance
 */
export function back<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>
) {
  router.history.back();
}

/**
 * Create href of a route path. For {@link Link Link Component} hover url preview.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param to route path
 * @returns href
 */
export function createHref<R extends BaseRoute = BaseRoute, V = any>(
  {baseUrl, history}: RouterInstance<R, V>,
  to: string
) {
  return baseUrl + history.createHref(to);
}

/**
 * Cancel the current navigate.
 * @group Methods
 * @category Router
 * @param router router instance
 */
export function cancel<R extends BaseRoute = BaseRoute, V = any>({
  cancelAll,
  onLoadingChange = noop
}: RouterInstance<R, V>) {
  cancelAll();
  onLoadingChange();
}

export function initHistoryStack<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>
) {
  const {history} = router;
  const {locationStack} = getHistoryState(router);

  return Promise.all(locationStack.map((l) => resolve(router, l))).then(
    (views) => {
      router.viewStack = views;
      history.replace(createPath(history.location), history.location.state);
    }
  );
}

/**
 * Listen the history change.
 * @group Methods
 * @category Router
 * @param router router instance
 * @param onViewChange a callback function will be call when view changed
 * @returns unlisten - A function that may be used to stop listening
 */
export function listen<R extends BaseRoute = BaseRoute, V = any>(
  router: RouterInstance<R, V>,
  onViewChange: (v: V) => void
) {
  const {history} = router;

  const rmListener = history.listen(({action, location}) => {
    cancel(router);

    const state = location.state as HistoryState | undefined;
    const index = state?.index || 0;
    const view = router.viewStack[index];

    onViewChange(view);
    if (!view) refresh(router);

    if (action === 'POP') {
      history.replace(createPath(history.location), {
        ...state,
        locationStack: router.locationStack
      });
    }
  });

  history.replace(createPath(history.location), history.location.state);

  return () => {
    cancel(router);
    rmListener();
  };
}
