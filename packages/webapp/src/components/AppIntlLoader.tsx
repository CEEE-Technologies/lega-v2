// @ts-nocheck
import * as FF from 'fp-ts/function';
import { find } from 'lodash';
import moment from 'moment';
import React from 'react';
import intl from 'react-intl-universal';
import rtlDetect from 'rtl-detect';
import { setLocale } from 'yup';
import { AppIntlProvider } from './AppIntlProvider';
import { withDashboardActions } from '@/containers/Dashboard/withDashboardActions';
import { useSplashLoadingState } from '@/hooks/state';

const SUPPORTED_LOCALES = [
  { name: 'English', value: 'en' },
  { name: 'العربية', value: 'ar' },
];

/**
 * Retrieve the current local.
 */
function getCurrentLocal() {
  let currentLocale = intl.determineLocale({
    urlLocaleKey: 'lang',
    cookieLocaleKey: 'locale',
    localStorageLocaleKey: 'lang',
  });
  if (!find(SUPPORTED_LOCALES, { value: currentLocale })) {
    currentLocale = 'en';
  }
  return currentLocale;
}

/**
 * Loads the localization data of the given locale.
 */
async function loadLocales(currentLocale) {
  return await import(`../lang/${currentLocale}/index.json`).then(
    (module) => module.default,
  );
}

/**
 * Loads the localization data of yup validation library.
 */
async function loadYupLocales(currentLocale) {
  return await import(`../lang/${currentLocale}/locale.tsx`).then(
    (module) => module.locale,
  );
}

/**
 * Dynamically loads the moment.js locale bundle for the given locale.
 */
async function loadMomentLocale(currentLocale) {
  const momentLocale = transformMomentLocale(currentLocale);
  if (momentLocale === 'en') return;
  // Vite cannot resolve variable bare-package specifiers at runtime.
  if (momentLocale === 'ar-ly') await import('moment/locale/ar-ly');
}

/**
 * Modifies the html document direction to RTl if it was rtl-language.
 */
function useDocumentDirectionModifier(locale, isRTL) {
  React.useEffect(() => {
    if (isRTL) {
      const htmlDocument = document.querySelector('html');
      htmlDocument.setAttribute('dir', 'rtl');
      htmlDocument.setAttribute('lang', locale);
    }
  }, [isRTL, locale]);
}

function transformMomentLocale(currentLocale) {
  return currentLocale === 'ar' ? 'ar-ly' : currentLocale;
}

/**
 * Loads application locales of the given current locale.
 * @param {string} currentLocale
 * @returns {{ isLoading: boolean }}
 */
function useAppLoadLocales(currentLocale) {
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    // Lodas the locales data file.
    loadLocales(currentLocale)
      .then((results) => {
        return intl.init({
          currentLocale,
          locales: {
            [currentLocale]: results,
          },
        });
      })
      .then(() => loadMomentLocale(currentLocale))
      .then(() => {
        moment.locale(transformMomentLocale(currentLocale));
        setIsLoading(false);
      });
  }, [currentLocale]);

  return { isLoading };
}

/**
 * Loads application yup locales based on the given current locale.
 * @param {string} currentLocale
 * @returns {{ isLoading: boolean }}
 */
function useAppYupLoadLocales(currentLocale) {
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    loadYupLocales(currentLocale)
      .then((results) => {
        setLocale(results);
        setIsLoading(false);
      })
      .then(() => {});
  }, [currentLocale]);

  return { isLoading };
}

/**
 * Application Intl loader.
 */
function AppIntlLoader({ children }) {
  // Retrieve the current locale.
  const currentLocale = getCurrentLocal();

  // Detarmines the document direction based on the given locale.
  const isRTL = rtlDetect.isRtlLang(currentLocale);

  // Modifies the html document direction
  useDocumentDirectionModifier(currentLocale, isRTL);

  // Loads yup localization of the given locale.
  const { isLoading: isAppYupLocalesLoading } =
    useAppYupLoadLocales(currentLocale);

  // Loads application locales of the given locale.
  const { isLoading: isAppLocalesLoading } = useAppLoadLocales(currentLocale);

  // Detarmines whether the app locales loading.
  const isLoading = isAppYupLocalesLoading || isAppLocalesLoading;
  useSplashLoadingState(isLoading);

  return (
    <AppIntlProvider currentLocale={currentLocale} isRTL={isRTL}>
      {isLoading ? null : children}
    </AppIntlProvider>
  );
}

export default FF.pipe(AppIntlLoader, withDashboardActions);
