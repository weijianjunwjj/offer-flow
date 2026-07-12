export interface NavigationConfirmAdapter {
  confirmDiscardChanges(message: string): boolean;
}

export const navigationConfirm: NavigationConfirmAdapter = {
  confirmDiscardChanges(message) {
    return window.confirm(message);
  },
};
