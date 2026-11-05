/**
 * Wspolna blokada operacji zapisu w main (ADR 0030, "jednobiezna").
 *
 * Zapisy (biblioteka, import, eksport, synchronizacja, cofniecie) moga dzialac obok siebie,
 * bo kazdy ma wlasna serializacje. Odbudowa indeksu nie moze: wymienia plik, na ktorym te
 * operacje pracuja. Dlatego odbudowa wchodzi tylko wtedy, gdy nie trwa zaden zapis, a zaden
 * zapis nie wchodzi w trakcie odbudowy.
 */
export type Release = () => void;

export class OperationLock {
  private writers = 0;
  private rebuilding = false;

  /** `null`, gdy trwa odbudowa. */
  tryEnterWrite(): Release | null {
    if (this.rebuilding) return null;
    this.writers += 1;
    return once(() => {
      this.writers -= 1;
    });
  }

  /** `null`, gdy trwa jakikolwiek zapis albo inna odbudowa. */
  tryEnterRebuild(): Release | null {
    if (this.rebuilding || this.writers > 0) return null;
    this.rebuilding = true;
    return once(() => {
      this.rebuilding = false;
    });
  }

  isRebuilding(): boolean {
    return this.rebuilding;
  }
}

function once(release: Release): Release {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    release();
  };
}
