import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { CourtSnapshot } from "../types";
import { commitToHub, loadHub, type CommitRequest, type CommitResult } from "./collab";

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getSnapshot: builder.query<CourtSnapshot, void>({
      queryFn: async () => ({ data: loadHub() }),
    }),
    commitSnapshot: builder.mutation<CommitResult, CommitRequest>({
      queryFn: async (request) => ({ data: commitToHub(request) }),
    }),
  }),
});

export const { useGetSnapshotQuery, useCommitSnapshotMutation } = courtApi;
