import { Component, DestroyRef, OnInit } from '@angular/core';
import { CommonModule } from "@angular/common";
import { HttpClientModule, HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ReactiveFormsModule, FormBuilder, FormGroup } from "@angular/forms";

import {MatCardModule} from '@angular/material/card';
import {MatInputModule} from '@angular/material/input';
import {MatButtonModule} from '@angular/material/button';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatIconModule} from '@angular/material/icon';

import {FlexLayoutModule} from '@angular/flex-layout';

import {
  catchError,
  combineLatest,
  distinctUntilChanged,
  from,
  map,
  merge,
  Observable,
  of,
  switchMap,
  timer
} from "rxjs";
import {takeUntilDestroyed} from "@angular/core/rxjs-interop";


const fields = [ "account", "amount", "message" ] as const;
type Field = typeof fields[number];
type FormState = Record<Field, string>;

type RequestState = "loading" | "success" | "failed";
type RequestErrors = { generic: string | null, fields: Record<Field, string | null> };
type RequestResult = { state: RequestState, blob: Blob | null, errors: RequestErrors };

const loadingSingleton = { state: "loading", blob: null, errors: { generic: null, fields: {} }} as RequestResult;
fields.forEach((field: Field) => loadingSingleton.errors.fields[field] = null);


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    HttpClientModule,
    ReactiveFormsModule,

    MatCardModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    FlexLayoutModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent implements OnInit {
  title = 'payment-qr';


  form!: FormGroup;
  requestResult?: RequestResult;
  imageUrl?: string;

  constructor(
    private httpClient: HttpClient,
    private formBuilder: FormBuilder,
    private destroyRef: DestroyRef
  ) { }


  ngOnInit(): void {
    // Setup form
    const controls = {} as Record<Field, []>;
    for (let field of fields)
      controls[field] = [];
    this.form = this.formBuilder.group(controls);

    // The current state of the form as an observable
    const formState$ = combineLatest(
      fields.map(field => this.form.controls[field].valueChanges),
      (...args) => {
        const state = {} as FormState;
        fields.forEach((field, index) => state[field] = args[index].trim());
        return state;
      },
    ).pipe(
      distinctUntilChanged(
        (a,b) => fields.every(field => a[field] === b[field])
      )
    );

    // This observable encapsulates the request
    const requestResult$ = formState$.pipe(
      switchMap(state => merge(
        of(loadingSingleton),
        timer(500).pipe(
          switchMap(() => this.getQrCodeForState(state))
        )
      )),
      distinctUntilChanged((a,b) => a === b)
    );

    // This subscribes to the changes
    requestResult$.pipe(
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(
      requestResult => {
        this.requestResult = requestResult;
        this.imageUrl = (requestResult?.blob) ? URL.createObjectURL(requestResult?.blob) : undefined;
      }
    );

    // Initiate form
    const params = new URL(window.location.href).searchParams;
    for (let field of fields)
      this.form.controls[field].setValue(params.get(field) ?? "");

  }

  getQrCodeForState(state: FormState): Observable<RequestResult> {

    const errors = { generic: null, fields: {} } as RequestErrors;
    fields.forEach((field: Field) => errors.fields[field] = null);

    const [ accountMatch ] = state.account.matchAll(/(?:(\d{1,6})-)?(\d{2,10})\/(\d{4})/g);
    const [ _, accountPrefix, accountNumber, bankCode ] = accountMatch ?? [];

    if (!accountMatch) {
      errors.generic = "QR kód se nepodařilo vygenerovat.";
      errors.fields.account = "Neplatné číslo účtu";
    }

    const [ amountMatch ] = state.amount.matchAll(/\d+(?:\.\d\d?)?/g);
    if (!amountMatch) {
      errors.generic = "QR kód se nepodařilo vygenerovat.";
      errors.fields.amount = "Neplatný formát čísla";
    }

    if (errors.generic !== null) {
      return of({
        state: "failed",
        blob: null,
        errors
      });
    }

    const params = new URLSearchParams({
      ...(accountPrefix ? { accountPrefix } : {}),
      accountNumber,
      bankCode,
      amount: state.amount,
      currency: "CZK",
      message: state.message,
      branding: "false",
    });
    const url = "https://api.paylibo.com/paylibo/generator/czech/image?" + params;

    return this.httpClient
      .get(url, { observe: "response", responseType: "blob"})
      .pipe(
        map(response => {
          if (response.ok && response.body) {
            return {
              state: "success",
              blob: response.body,
              errors,
            } as RequestResult;
          }

          errors.generic = "QR kód se nepodařilo vygenerovat.";
          return {
            state: "failed",
            blob: null,
            errors,
          } as RequestResult;
        }),
        catchError((errorResponse, caught) => {
          errors.generic = "QR kód se nepodařilo vygenerovat.";

          if (!(errorResponse instanceof HttpErrorResponse) || !(errorResponse.error instanceof Blob)) {
            return of({
              state: "failed",
              blob: null,
              errors,
            } as RequestResult);
          }

          return from(errorResponse.error.text()).pipe(
            map(errorJson => {
              try {
                const errorObject = JSON.parse(errorJson)
                errorObject?.errors?.forEach((error: any) => {
                  if (error?.description)
                    errors.generic += " " + error?.description;
                })

              } catch { }

              return {
                state: "failed",
                blob: null,
                errors,
              } as RequestResult;
            })
          );

        })
      );
  }


  protected readonly switchMap = switchMap;
  protected readonly URL = URL;
}
