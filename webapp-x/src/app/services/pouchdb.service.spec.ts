import { TestBed } from '@angular/core/testing';

import { PouchDB } from './pouchdb.service';

describe('PouchDB', () => {
  let service: PouchDB;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PouchDB);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
